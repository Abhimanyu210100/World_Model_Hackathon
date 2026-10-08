import { LingbotWorld2Model } from "@reactor-models/lingbot-world-2";
import { chime, creak, heartbeat, hushBeds, initAudio, loadVoices, scareHit, setBeds, speak, whisperSting } from "./audio";

// ---------- Types (mirrors public/generated/script.json written by `npm run generate`)

interface Room {
  id: string;
  name: string;
  lingbot_prompt: string;
  key_spot: string;
  entry_line: string;
  search_fail_lines: string[];
  scare_lingbot_prompt: string;
  exits: string[];
  keyCandidate: boolean;
}

interface Script {
  title: string;
  intro: string;
  rooms: Room[];
  key_found_line: string;
  locked_door_line: string;
  win_line: string;
  lose_line: string;
  whispers: string[];
}

interface Verdict {
  key_visible: boolean;
  key_reachable: boolean;
  door_visible: boolean;
  narration: string;
  direction: string;
}

// ---------- Tunables

const TIME_LIMIT_MS = 2 * 60_000;
// One scripted scare per run, preceded by a warning (both in elapsed play time).
const WARNING_AT_MS = 50_000;
const SCARE_AT_MS = 60_000;
const SCARE_LINGER_MS = 5_000;
const WARNING_LINE = "You should never turn your back towards open hallways.";

// Looping Gemini-TTS ambience per room (see scripts/voice.mjs).
const ROOM_BEDS: Record<string, string[]> = {
  foyer: ["bed_breathing"],
  hallway: ["bed_whispers_a", "bed_whispers_b"],
  nursery: ["bed_lullaby"],
  kitchen: ["bed_breathing", "bed_moans"],
  basement: ["bed_moans", "bed_whispers_b"],
};

// ---------- DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("world");
const still = $<HTMLImageElement>("still");
const fade = $("fade");
const scareImg = $<HTMLImageElement>("scare");
const scareWrap = $("scare-wrap");
const redflash = $("redflash");
const flashlight = $("flashlight");
const hud = $("hud");
const roomName = $("room-name");
const timerEl = $("timer");
const inventory = $("inventory");
const narrationEl = $("narration");
const exitsEl = $("exits");
const titleScreen = $("title");
const beginBtn = $<HTMLButtonElement>("begin");
const endScreen = $("end");
const objectiveEl = $("objective");
const helpEl = $("help");

// ---------- State

let script: Script;
let model: LingbotWorld2Model | null = null;
let room: Room;
let keyRoom = "";
let hasKey = false;
let busy = true;
let over = false;
let ending = false;
let deadline = 0;
let warned = false;
let scared = false;
let lastBeat = 0;
let generationStarted: (() => void) | null = null;
let loopTimer = 0;
let roomReady = false;
let introPlaying = false;

const roomById = (id: string) => script.rooms.find((r) => r.id === id)!;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function roomImage(r: Room) {
  if (r.id === keyRoom && !hasKey) return `/generated/${r.id}_key.png`;
  return `/generated/${r.id}.png`;
}

function roomPrompt(r: Room) {
  const keyBit = r.id === keyRoom && !hasKey ? ` A small tarnished brass key rests ${r.key_spot}, glinting faintly.` : "";
  return r.lingbot_prompt + keyBit;
}

function searchFailLine() {
  const i = Math.floor(Math.random() * room.search_fail_lines.length);
  narrate(room.search_fail_lines[i]);
  speak(`search_${room.id}_${i}`);
}

function whisperLine() {
  const i = Math.floor(Math.random() * script.whispers.length);
  narrate(script.whispers[i], { whisper: true });
  speak(`whisper_${i}`);
}

let narrationTimer = 0;
function narrate(text: string, opts: { whisper?: boolean; ms?: number } = {}) {
  narrationEl.textContent = text;
  narrationEl.classList.toggle("whisper", !!opts.whisper);
  narrationEl.style.opacity = "1";
  clearTimeout(narrationTimer);
  narrationTimer = window.setTimeout(() => (narrationEl.style.opacity = "0"), opts.ms ?? 6000);
}

// ---------- Reactor / LingBot-World-2

async function fetchJwt() {
  const r = await fetch("/api/reactor/token", { method: "POST" });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "token request failed");
  return body.jwt as string;
}

async function connectWorld() {
  // One token per connection: a session-scoped JWT may only manage the
  // session it created, so a resolver that mints per request gets 403s.
  model = new LingbotWorld2Model({ jwt: await fetchJwt() });
  model.onMainVideo((_track, stream) => {
    video.srcObject = stream;
    video.play().catch(() => {});
  });
  model.onGenerationStarted(() => generationStarted?.());
  model.onCommandError((m) => console.warn("[lingbot] command_error", m.command, m.reason));

  const ready = new Promise<void>((resolve) => {
    model!.on("statusChanged", (s) => s === "ready" && resolve());
  });
  await model.connect();
  if (model.getStatus() !== "ready") await ready;
}

async function enterRoom(id: string) {
  busy = true;
  const loadStart = Date.now();
  roomReady = false;
  hideExits();
  stopMoving();
  fade.classList.remove("clear");
  creak();
  room = roomById(id);
  roomName.textContent = room.name;
  still.src = roomImage(room);
  setBeds(ROOM_BEDS[room.id] ?? []);
  await sleep(900);
  still.classList.add("show");
  fade.classList.add("clear");

  const m = model!;
  const started = new Promise<void>((resolve) => {
    generationStarted = resolve;
    setTimeout(resolve, 20_000);
  });
  await m.reset();
  const blob = await (await fetch(roomImage(room))).blob();
  const ref = await m.uploadFile(blob);
  await m.setImage({ image: ref });
  await m.setPrompt({ prompt: roomPrompt(room) });
  await m.start();
  await started;
  generationStarted = null;

  still.classList.remove("show");
  narrate(room.entry_line);
  // The intro narration covers the first foyer entry.
  if (!introPlaying) speak(`room_${room.id}`);
  introPlaying = false;
  // Loading time doesn't count against the clock.
  deadline += Date.now() - loadStart;
  roomReady = true;
  busy = false;
}

function setObjective() {
  objectiveEl.textContent = hasKey
    ? "Objective: get back to the foyer and escape through the front door (F → 1)"
    : "Objective: find the brass key hidden somewhere in the house";
}

// ---------- Movement

const held = new Set<string>();
const sent = { long: "idle", lat: "idle", h: "idle", v: "idle" };

function axis(neg: string[], pos: string[], negVal: string, posVal: string) {
  const n = neg.some((k) => held.has(k));
  const p = pos.some((k) => held.has(k));
  return n === p ? "idle" : n ? negVal : posVal;
}

function syncMovement() {
  if (!model || busy) return;
  const want = {
    long: axis(["s"], ["w"], "back", "forward"),
    lat: axis(["a"], ["d"], "strafe_left", "strafe_right"),
    h: axis(["arrowleft"], ["arrowright"], "left", "right"),
    v: axis(["arrowdown"], ["arrowup"], "down", "up"),
  };
  if (want.long !== sent.long) model.setMoveLongitudinal({ move_longitudinal: want.long as any });
  if (want.lat !== sent.lat) model.setMoveLateral({ move_lateral: want.lat as any });
  if (want.h !== sent.h) model.setLookHorizontal({ look_horizontal: want.h as any });
  if (want.v !== sent.v) model.setLookVertical({ look_vertical: want.v as any });
  Object.assign(sent, want);
}

function stopMoving() {
  held.clear();
  if (!model) return;
  model.setMoveLongitudinal({ move_longitudinal: "idle" });
  model.setMoveLateral({ move_lateral: "idle" });
  model.setLookHorizontal({ look_horizontal: "idle" });
  model.setLookVertical({ look_vertical: "idle" });
  Object.assign(sent, { long: "idle", lat: "idle", h: "idle", v: "idle" });
}

// ---------- Gemini game master (judges the live frame)

function captureFrame(): string {
  const src: CanvasImageSource = video.videoWidth ? video : still;
  const w = 640;
  const h = video.videoWidth ? Math.round((w * video.videoHeight) / video.videoWidth) : 358;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(src, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.75).split(",")[1];
}

async function judge(intent: "search" | "door" | "hint"): Promise<Verdict | null> {
  try {
    const r = await fetch("/api/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frame: captureFrame(),
        intent,
        room: room.name,
        keyHere: room.id === keyRoom && !hasKey,
        keySpot: room.key_spot,
        keyRoomName: roomById(keyRoom).name,
        hasKey,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    return await r.json();
  } catch (e) {
    console.warn("[gemini] judge failed", e);
    return null;
  }
}

async function search() {
  busy = true;
  stopMoving();
  narrate("You search, hands shaking…", { ms: 20_000 });
  const v = await judge("search");
  busy = false;
  if (room.id === keyRoom && !hasKey && v?.key_visible) {
    hasKey = true;
    chime();
    inventory.textContent = "🗝  brass key";
    setObjective();
    narrate(script.key_found_line);
    speak("key_found");
    model?.setPrompt({ prompt: roomPrompt(room) });
    return;
  }
  if (room.id === keyRoom && !hasKey && v) narrate(`${v.narration} ${v.direction}`);
  else searchFailLine();
}

async function useDoor() {
  busy = true;
  stopMoving();
  narrate("You reach for the door…", { ms: 20_000 });
  const v = await judge("door");
  busy = false;
  // If Gemini is unreachable, don't trap the player.
  if (v && !v.door_visible) {
    narrate(`${v.narration} There is no door within reach.`);
    return;
  }
  showExits();
}

async function hint() {
  busy = true;
  stopMoving();
  whisperSting();
  narrate("You hold your breath and listen…", { whisper: true, ms: 20_000 });
  const v = await judge("hint");
  busy = false;
  if (v) narrate(v.direction, { whisper: true, ms: 8000 });
  else whisperLine();
}

function showExits() {
  exitsEl.innerHTML = "<h3>Where?</h3>";
  const options: [string, () => void][] = room.exits.map((id) => [roomById(id).name, () => enterRoom(id)]);
  if (room.id === "foyer") options.unshift(["The front door", tryFrontDoor]);
  options.push(["Stay here", hideExits]);
  options.forEach(([label, fn], i) => {
    const b = document.createElement("button");
    b.textContent = `${i + 1}. ${label}`;
    b.onclick = () => {
      hideExits();
      fn();
    };
    exitsEl.append(b);
  });
  exitsEl.hidden = false;
}

function hideExits() {
  exitsEl.hidden = true;
}

function tryFrontDoor() {
  if (hasKey) return finish(true);
  narrate(script.locked_door_line);
  speak("door_locked");
}

// ---------- Jump scares

// Full-screen faces painted by Gemini (scripts/generate.mjs). Face 1 is a
// wider body shot, so only the true close-ups are used.
const SCARE_FACES = ["/generated/scare_face_0.png", "/generated/scare_face_2.png"];
const SCARE_HIT_MS = 2100;

async function jumpScare() {
  if (over || ending || !model) return;
  const r = room;
  stopMoving();

  // Build-up: everything goes quiet, the flashlight dies, two heartbeats.
  hushBeds();
  narrationEl.style.opacity = "0";
  flashlight.style.filter = "brightness(0.08)";
  heartbeat();
  await sleep(750);
  heartbeat();
  await sleep(rand(900, 1500));

  // Hit: a screaming face fills the entire screen.
  scareImg.src = pick(SCARE_FACES);
  scareWrap.classList.remove("go");
  redflash.classList.remove("go");
  void scareWrap.offsetWidth;
  scareWrap.classList.add("go");
  redflash.classList.add("go");
  scareHit(pick(["shriek_0", "shriek_1"]));
  await sleep(SCARE_HIT_MS);
  scareWrap.classList.remove("go");
  flashlight.style.filter = "";
  setBeds(ROOM_BEDS[r.id] ?? []);

  // Aftermath: the figure lingers inside the live world model, then the
  // context is wiped back to the grounding image so it "vanishes".
  model?.setPrompt({ prompt: r.scare_lingbot_prompt });
  setTimeout(whisperLine, 1200);
  await sleep(SCARE_LINGER_MS);
  if (ending || over || room !== r || !model) return;
  await model.setPrompt({ prompt: roomPrompt(r) });
  await model.triggerKvCacheReset().catch(() => {});
}

function warn() {
  whisperSting();
  narrate(WARNING_LINE, { whisper: true, ms: 7000 });
  speak("warning");
}

// ---------- Main loop & lifecycle

function tick() {
  if (over || ending) return;
  if (busy && !roomReady) return;
  const left = deadline - Date.now();
  if (left <= 0) return void finish(false);
  const s = Math.ceil(left / 1000);
  timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const beatEvery = left < 30_000 ? 600 : left < 60_000 ? 1000 : Infinity;
  if (Date.now() - lastBeat > beatEvery) {
    heartbeat();
    lastBeat = Date.now();
  }
  const elapsed = TIME_LIMIT_MS - left;
  if (!warned && elapsed >= WARNING_AT_MS) {
    warned = true;
    warn();
  }
  // Waits for any in-flight search/door check so the scare lands on a live view.
  if (!scared && !busy && elapsed >= SCARE_AT_MS) {
    scared = true;
    jumpScare();
  }
}

async function finish(won: boolean) {
  if (ending || over) return;
  ending = true;
  busy = true;
  clearInterval(loopTimer);
  over = true;
  hud.hidden = true;
  $("end-title").textContent = won ? "You escaped." : "It found you.";
  $("end-text").textContent = won ? script.win_line : script.lose_line;
  speak(won ? "win" : "lose");
  if (won) setBeds([]);
  endScreen.hidden = false;
  // Stop billing as soon as the run ends.
  await model?.reset().catch(() => {});
  await model?.disconnect().catch(() => {});
  model = null;
}

const MAX_CONNECT_ATTEMPTS = 8;

// Reactor answers 429 when every LingBot GPU is busy; that clears on its own.
const isCapacityError = (e: any) => e?.status === 429 || /429|capacity/i.test(`${e?.message} ${e?.cause?.message}`);

async function begin() {
  endScreen.hidden = true;
  titleScreen.hidden = false;
  beginBtn.disabled = true;
  beginBtn.textContent = "Opening the door…";
  for (let attempt = 1; !model; attempt++) {
    try {
      await connectWorld();
    } catch (e: any) {
      console.error(e);
      // connectWorld() may have assigned model before throwing.
      await (model as LingbotWorld2Model | null)?.disconnect().catch(() => {});
      model = null;
      if (isCapacityError(e) && attempt < MAX_CONNECT_ATTEMPTS) {
        const wait = Math.min(5 * 2 ** (attempt - 1), 30);
        for (let s = wait; s > 0; s--) {
          beginBtn.textContent = `The house is full. Knocking again in ${s}s… (try ${attempt + 1}/${MAX_CONNECT_ATTEMPTS})`;
          await sleep(1000);
        }
        continue;
      }
      beginBtn.textContent = "Could not reach the house. Retry";
      beginBtn.disabled = false;
      $("intro").textContent = isCapacityError(e)
        ? "Reactor has no free LingBot servers right now. Wait a minute and try again."
        : `${e?.message ?? e}${e?.cause ? ` (${e.cause.message ?? e.cause})` : ""}`;
      return;
    }
  }
  titleScreen.hidden = true;
  endScreen.hidden = true;
  // Space is the hint key; don't let it re-press a focused button.
  (document.activeElement as HTMLElement | null)?.blur();
  hud.hidden = false;
  over = false;
  ending = false;
  warned = false;
  scared = false;
  hasKey = false;
  inventory.textContent = "";
  helpEl.hidden = true;
  keyRoom = pick(script.rooms.filter((r) => r.keyCandidate)).id;
  deadline = Date.now() + TIME_LIMIT_MS;
  loopTimer = window.setInterval(tick, 250);
  setObjective();
  await enterRoom("foyer");
  narrate("Look around with the arrow keys. Press SPACE if you are lost, E to search, F at a doorway to move rooms.", { ms: 10_000 });
}

window.addEventListener("keydown", (e) => {
  if (over || titleScreen.hidden === false) return;
  const k = e.key.toLowerCase();
  if (k === "?" || k === "/" || k === "tab") {
    e.preventDefault();
    helpEl.hidden = !helpEl.hidden;
    return;
  }
  if (k === " ") e.preventDefault();
  if (busy) return;
  if (!exitsEl.hidden) {
    const n = Number(k);
    const buttons = exitsEl.querySelectorAll("button");
    if (n >= 1 && n <= buttons.length) buttons[n - 1].click();
    if (k === "escape") hideExits();
    return;
  }
  if (k.startsWith("arrow")) e.preventDefault();
  if (e.repeat) return;
  if (k === "e") return void search();
  if (k === "f") return void useDoor();
  if (k === " ") return void hint();
  held.add(k);
  syncMovement();
});
window.addEventListener("keyup", (e) => {
  held.delete(e.key.toLowerCase());
  syncMovement();
});
window.addEventListener("blur", stopMoving);
window.addEventListener("mousemove", (e) => {
  flashlight.style.setProperty("--x", `${(e.clientX / innerWidth) * 100}%`);
  flashlight.style.setProperty("--y", `${(e.clientY / innerHeight) * 100}%`);
});
document.addEventListener("visibilitychange", () => {
  if (!model || over) return;
  if (document.hidden) model.pause().catch(() => {});
  else model.resume().catch(() => {});
});
window.addEventListener("pagehide", () => model?.disconnect());

beginBtn.onclick = () => {
  initAudioOnce();
  begin();
};
$("again").onclick = () => begin();

let audioReady = false;
function initAudioOnce() {
  if (audioReady) return;
  audioReady = true;
  initAudio();
  loadVoices().then(() => {
    // Narrate the intro while the first room loads.
    if (!titleScreen.hidden || busy) {
      introPlaying = true;
      speak("intro");
    }
  });
}

(async () => {
  const r = await fetch("/generated/script.json");
  if (!r.ok) {
    $("intro").textContent = "No script found. Run `npm run generate` first.";
    return;
  }
  script = await r.json();
  document.title = script.title;
  $("title-text").textContent = script.title;
  $("intro").textContent = script.intro;
  still.src = "/generated/foyer.png";
  still.classList.add("show");
  for (const src of SCARE_FACES) new Image().src = src;
  // Preload every image so scares hit instantly.
  for (const room of script.rooms) {
    for (const suffix of ["", "_scare", "_key"]) new Image().src = `/generated/${room.id}${suffix}.png`;
  }
  beginBtn.disabled = false;
})();
