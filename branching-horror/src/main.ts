import { FastH3Model } from "@reactor-models/fast-h3";
import type { FileRef } from "@reactor-team/js-sdk";
import storyData from "./story.json";
import { clipDuration, heartbeat, hushBeds, initAudio, loadVoices, scareHit, setBeds, speak, whisperSting } from "./audio";

// ---------- Story (hand-written in src/story.json)

type Ending = "death" | "escape" | "twist";

interface Shot {
  narration: string;
  prompt: string;
}

interface StoryNode {
  title: string;
  frame?: string; // open from this grounding image instead of continuing the previous clip
  location: string;
  shots: Shot[]; // played back to back (~15s) before the choice
  choices?: { label: string; to: string }[];
  ending?: Ending;
  scare?: "end" | { shot: number; at: number }; // after the last shot, or N seconds into a shot
  whisper?: string; // voice clip whispered while the choices are up
}

const story = storyData as {
  title: string;
  intro: string;
  style: string;
  start: string;
  nodes: Record<string, StoryNode>;
};

/** A scene queued on FastH3: one clip per shot, each continuing the one before. */
interface Placed {
  id: string;
  node: StoryNode;
  parent: Placed | null;
  clipIds: string[];
  children: Promise<Placed[]> | null;
}

// ---------- Tunables

// Each shot runs as long as its narration (FastH3 accepts 5.167-14.375s).
const SHOT_MIN = 6;
const SHOT_MAX = 14.375;
const CHOICE_MS = 12_000;
const SCARE_FACES = ["/frames/scare_face_0.png", "/frames/scare_face_2.png"];
const LOCATION_BEDS: Record<string, string[]> = {
  foyer: ["bed_breathing"],
  hallway: ["bed_whispers_a", "bed_whispers_b"],
  nursery: ["bed_lullaby"],
  basement: ["bed_moans", "bed_whispers_b"],
};

// ---------- DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const film = $<HTMLVideoElement>("film");
const poster = $<HTMLImageElement>("poster");
const subtitle = $("subtitle");
const sceneTitle = $("scene-title");
const waiting = $("waiting");
const waitingText = $("waiting-text");
const choicesEl = $("choices");
const choiceBtns = [$<HTMLButtonElement>("choice-0"), $<HTMLButtonElement>("choice-1")];
const countdownBar = $("countdown-bar");
const titleScreen = $("title");
const beginBtn = $<HTMLButtonElement>("begin");
const statusEl = $("status");
const card = $("card");
const cardGo = $<HTMLButtonElement>("card-go");
const endScreen = $("end");
const scareWrap = $("scare-wrap");
const scareImg = $<HTMLImageElement>("scare");
const redflash = $("redflash");

// ---------- State

let model: FastH3Model | null = null;
const path: { id: string; chosen: number }[] = [];
const ready = new Set<string>();
const byClip = new Map<string, { p: Placed; i: number }>();
const frames = new Map<string, Promise<FileRef>>();
let onFinished: (() => void) | null = null;
let pickChoice: ((i: number) => void) | null = null;
let playingShot: string | null = null;
let duckTimer = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const show = (el: HTMLElement, on: boolean) => void (el.hidden = !on);

// ---------- Reactor / FastH3

async function fetchJwt() {
  const r = await fetch("/api/reactor/token", { method: "POST" });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "token request failed");
  return body.jwt as string;
}

const isCapacityError = (e: any) => e?.status === 429 || /429|capacity/i.test(`${e?.message} ${e?.cause?.message}`);

async function connect() {
  // One fixed token per connection: a session-scoped JWT may only manage the
  // session it created, so a resolver that mints per request gets 403s.
  const jwt = await fetchJwt();
  const waitStart = Date.now();
  for (;;) {
    const m = new FastH3Model({ jwt });
    try {
      const mixed = new MediaStream();
      const attach = (track: MediaStreamTrack) => {
        mixed.addTrack(track);
        if (film.srcObject !== mixed) film.srcObject = mixed;
        film.play().catch(() => {});
      };
      m.onMainVideo((t) => attach(t));
      m.onMainAudio((t) => attach(t));
      m.onClipGenerated(({ clip }) => ready.add(clip.clip_id));
      m.onClipFailed(async ({ clip, reason }) => {
        console.warn("[fast-h3] clip failed, retrying:", reason);
        const hit = byClip.get(clip.clip_id);
        if (hit) hit.p.clipIds[hit.i] = await enqueueShot(hit.p, hit.i); // whenReady() polls clipIds
      });
      m.onClipFinished(() => onFinished?.());
      m.onCommandError((e) => console.warn("[fast-h3] command_error", e.command, e.reason));

      const isReady = new Promise<void>((resolve) => m.on("statusChanged", (s) => s === "ready" && resolve()));
      await m.connect();
      if (m.getStatus() !== "ready") await isReady;
      model = m;
      return;
    } catch (e) {
      await m.disconnect().catch(() => {});
      if (!isCapacityError(e)) throw e;
      const waited = Math.round((Date.now() - waitStart) / 1000);
      statusEl.textContent = `FastH3 servers are full. Waiting for one to free up… ${waited}s`;
      await sleep(rand(4000, 6000));
    }
  }
}

async function configure() {
  const m = model!;
  await m.reset();
  await m.setCanvas({ aspect: "16:9" });
  await m.setAutoplay({ enabled: false });
  // Hold the last frame between clips, so the choice appears over a freeze-frame.
  await m.setFlushOnClipEnd({ enabled: false });
  await m.setClipSeconds({ seconds: 8 });
}

function frameRef(name: string) {
  if (!frames.has(name)) {
    frames.set(
      name,
      fetch(`/frames/${name}.png`)
        .then((r) => r.blob())
        .then((b) => model!.uploadFile(b)),
    );
  }
  return frames.get(name)!;
}

const shotSeconds = (id: string, i: number) =>
  Math.min(SHOT_MAX, Math.max(SHOT_MIN, clipDuration(`n_${id}_${i}`) + 1));

/** Queue one shot. The first opens from the scene's grounding image or continues
 *  the parent's last shot; later shots continue the shot before. */
async function enqueueShot(p: Placed, i: number): Promise<string> {
  const node = p.node;
  const from =
    i > 0 ? p.clipIds[i - 1] : node.frame || !p.parent ? "" : p.parent.clipIds[p.parent.clipIds.length - 1];
  for (let attempt = 0; ; attempt++) {
    const reply = await model!.enqueue({
      prompt: `${node.shots[i].prompt}\nStyle: ${story.style}`,
      metadata: `${p.id}#${i}`,
      seconds: shotSeconds(p.id, i),
      starting_frame: i === 0 && node.frame ? await frameRef(node.frame) : null,
      continue_from_clip_id: from,
    });
    if (reply?.clip) {
      byClip.set(reply.clip.clip_id, { p, i });
      return reply.clip.clip_id;
    }
    // Usually a full generation queue: wait for a slot.
    if (attempt > 40) throw new Error(`FastH3 refused scene "${p.id}"`);
    await sleep(1500);
  }
}

const newPlaced = (id: string, parent: Placed | null): Placed => ({
  id,
  node: story.nodes[id],
  parent,
  clipIds: [],
  children: null,
});

/** Queue every shot of the given scenes, interleaved so each scene's first shot builds first. */
async function enqueueScenes(ps: Placed[]) {
  const most = Math.max(...ps.map((p) => p.node.shots.length));
  for (let i = 0; i < most; i++) {
    for (const p of ps) if (i < p.node.shots.length) p.clipIds[i] = await enqueueShot(p, i);
  }
}

/** Render both outcomes of a scene right behind it. */
function placeChildren(p: Placed) {
  const kids = (p.node.choices ?? []).map((c) => newPlaced(c.to, p));
  p.children = enqueueScenes(kids).then(() => kids);
}

function whenReady(p: Placed, i: number) {
  return new Promise<void>((resolve) => {
    const check = () => (ready.has(p.clipIds[i]) ? resolve() : setTimeout(check, 250));
    check();
  });
}

// ---------- Narration & sound

/** Narrator line, with the film's own audio lowered underneath it. */
function narrate(clip: string) {
  const secs = speak(clip);
  if (!secs) return 0;
  film.volume = 0.45;
  clearTimeout(duckTimer);
  duckTimer = window.setTimeout(() => (film.volume = 1), secs * 1000);
  return secs;
}

// ---------- Jump scare

async function jumpScare(buildUp: boolean) {
  if (buildUp) {
    hushBeds();
    film.volume = 0.15;
    heartbeat();
    await sleep(750);
    heartbeat();
    await sleep(rand(700, 1200));
  }
  scareImg.src = pick(SCARE_FACES);
  scareWrap.classList.remove("go");
  redflash.classList.remove("go");
  void scareWrap.offsetWidth;
  scareWrap.classList.add("go");
  redflash.classList.add("go");
  scareHit(pick(["shriek_0", "shriek_1"]));
  await sleep(2100);
  scareWrap.classList.remove("go");
  film.volume = 1;
}

// ---------- Playback

const WAITING_LINES = ["Something is coming…", "Don't look away.", "It heard that.", "Hold your breath.", "The house is listening."];

async function playScene(p: Placed): Promise<void> {
  const node = p.node;
  setBeds(LOCATION_BEDS[node.location] ?? []);
  sceneTitle.textContent = node.title;
  let narrationEnds = Date.now();

  for (let i = 0; i < node.shots.length; i++) {
    if (!ready.has(p.clipIds[i])) {
      waitingText.textContent = pick(WAITING_LINES);
      show(waiting, true);
      await whenReady(p, i);
      show(waiting, false);
    }
    // A long narration line may still be running from the previous shot.
    await sleep(Math.max(0, narrationEnds - Date.now()));

    const finished = new Promise<void>((resolve) => (onFinished = resolve));
    const shotId = `${p.id}#${i}`;
    playingShot = shotId;
    await model!.play({ clip_id: p.clipIds[i] });
    poster.classList.remove("show");
    subtitle.textContent = node.shots[i].narration;
    subtitle.classList.add("show");
    narrationEnds = Date.now() + narrate(`n_${p.id}_${i}`) * 1000;
    if (typeof node.scare === "object" && node.scare.shot === i) {
      setTimeout(() => playingShot === shotId && jumpScare(false), node.scare.at * 1000);
    }
    await finished;
    onFinished = null;
  }
  playingShot = null;
  // Let the narrator finish before the scene resolves.
  await sleep(Math.max(0, narrationEnds - Date.now()));
  subtitle.classList.remove("show");

  if (node.ending) {
    if (node.scare === "end") await jumpScare(true);
    return finish(p);
  }

  if (node.whisper) {
    const id = node.whisper;
    setTimeout(() => {
      whisperSting();
      narrate(id);
    }, 400);
  }
  const choice = await choose(node.choices!.map((c) => c.label));
  path.push({ id: p.id, chosen: choice });

  waitingText.textContent = pick(WAITING_LINES);
  show(waiting, true);
  const kids = await p.children!;
  show(waiting, false);
  const next = kids[choice];
  // Drop the road not taken (later shots first: earlier ones are referenced by them).
  kids.forEach((k, j) => {
    if (j === choice) return;
    for (const id of [...k.clipIds].reverse()) model!.pop({ clip_id: id }).catch(() => {});
  });
  // Put the chosen scene's shots at the front, in order.
  next.clipIds.forEach((id, pos) => !ready.has(id) && model!.move({ clip_id: id, position: pos }).catch(() => {}));
  if (next.node.choices) placeChildren(next);
  return playScene(next);
}

// ---------- Choices

function choose(options: string[]): Promise<number> {
  return new Promise((resolve) => {
    options.forEach((label, i) => (choiceBtns[i].querySelector("span")!.textContent = label));
    show(choicesEl, true);
    choiceBtns[0].focus();
    countdownBar.style.transition = "none";
    countdownBar.style.transform = "scaleX(1)";
    void countdownBar.offsetWidth;
    countdownBar.style.transition = `transform ${CHOICE_MS}ms linear`;
    countdownBar.style.transform = "scaleX(0)";

    const timer = setTimeout(() => {
      subtitle.textContent = "You hesitated. It chose for you.";
      subtitle.classList.add("show");
      setTimeout(() => subtitle.classList.remove("show"), 2500);
      done(Math.floor(Math.random() * options.length));
    }, CHOICE_MS);
    const done = (i: number) => {
      clearTimeout(timer);
      pickChoice = null;
      show(choicesEl, false);
      resolve(i);
    };
    pickChoice = done;
  });
}

choiceBtns.forEach((b, i) => (b.onclick = () => pickChoice?.(i)));
window.addEventListener("keydown", (e) => {
  if (!pickChoice) return;
  if (e.key === "1" || e.key === "ArrowLeft") pickChoice(0);
  if (e.key === "2" || e.key === "ArrowRight") pickChoice(1);
});

// ---------- Ending

const ENDING_TITLES: Record<Ending, string> = {
  death: "You died.",
  escape: "You escaped.",
  twist: "You were always here.",
};

async function finish(p: Placed) {
  const node = p.node;
  $("end-title").textContent = ENDING_TITLES[node.ending!];
  $("end-subtitle").textContent = node.shots[node.shots.length - 1].narration;
  const list = $("path");
  list.innerHTML = "";
  for (const step of path) {
    const n = story.nodes[step.id];
    const choices = n.choices!;
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="small">${esc(n.title)}:</span> <span class="chosen">${esc(choices[step.chosen].label)}</span>` +
      choices
        .filter((_, j) => j !== step.chosen)
        .map((c) => ` · <span class="not">${esc(c.label)}</span>`)
        .join("");
    list.append(li);
  }
  const deaths = Object.values(story.nodes).filter((n) => n.ending === "death").length;
  $("end-path-note").textContent = `${path.length + 1} scenes. There are ${deaths} ways to die in this house, one way out, and one truth.`;
  await sleep(node.ending === "death" ? 300 : 1500);
  show(endScreen, true);
  setBeds([]);
  // Stop billing as soon as the film ends.
  await model?.reset().catch(() => {});
  await model?.disconnect().catch(() => {});
  model = null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---------- Start

let audioReady: Promise<void> | null = null;

async function begin() {
  beginBtn.disabled = true;
  audioReady ??= (initAudio(), loadVoices());
  statusEl.textContent = "Opening the house…";
  path.length = 0;
  ready.clear();
  byClip.clear();
  frames.clear();
  try {
    if (!model) await connect();
    await configure();

    // Title card (with the narrator) while the opening renders.
    show(titleScreen, false);
    $("card-title").textContent = story.title;
    $("card-text").textContent = story.intro;
    show(cardGo, false);
    show(card, true);
    await audioReady;
    narrate("intro");

    const first = newPlaced(story.start, null);
    await enqueueScenes([first]);
    placeChildren(first);
    await whenReady(first, 0);
    show(cardGo, true);
    cardGo.focus();
    await new Promise<void>((resolve) => (cardGo.onclick = () => resolve()));
    show(card, false);
    await playScene(first);
  } catch (e: any) {
    console.error(e);
    for (const el of [card, choicesEl, waiting]) show(el, false);
    show(titleScreen, true);
    statusEl.textContent = `Something went wrong: ${e?.message ?? e}`;
    beginBtn.disabled = false;
    await model?.disconnect().catch(() => {});
    model = null;
  }
}

$("intro").textContent = story.intro;
poster.src = `/frames/${story.nodes[story.start].frame}.png`;
poster.classList.add("show");
for (const src of SCARE_FACES) new Image().src = src;

beginBtn.onclick = () => begin();
$("again").onclick = () => {
  show(endScreen, false);
  show(titleScreen, true);
  poster.classList.add("show");
  beginBtn.disabled = false;
  statusEl.textContent = "";
  sceneTitle.textContent = "";
};
window.addEventListener("pagehide", () => model?.disconnect());
