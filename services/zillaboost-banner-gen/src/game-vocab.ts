// Per-game visual vocabulary, keyed by sport slug.
//
// This exists because the local LLM does NOT reliably know what these
// games look like. Left to its own knowledge it produced tactical-
// shooter soldiers holding melee weapons for a DOTA 2 match (observed
// 2026-08-28) — the "esports arena + soldiers" attractor swallows every
// title. So the game's look is supplied as ground truth rather than
// asked for, and the prompt author is told to build on it.
//
// Each entry is a short comma-separated clause list in diffusion-prompt
// register: setting, characters, props, palette bias. Deliberately
// avoids trademarked character names — it describes the GENRE's visual
// language, which is what makes a banner read as "this is Dota" rather
// than "this is a shooter".

export interface GameVocab {
  /** Human name for the prompt's framing sentence. */
  label: string;
  /** Diffusion clauses describing the world. */
  scene: string;
}

const VOCAB: Record<string, GameVocab> = {
  cs2: {
    label: "Counter-Strike 2 (tactical 5v5 bomb-defusal shooter)",
    scene:
      "modern counter-terrorist operators in tactical vests and helmets, assault rifles held at the ready, dusty sunlit Mediterranean bomb-site architecture, smoke grenade haze, concrete and sand tones",
  },
  "cs2-duels": {
    label: "Counter-Strike 2 duels (1v1 aim duel)",
    scene:
      "two lone tactical shooters facing off across a narrow concrete corridor, rifle silhouettes, dust motes in a single hard shaft of light",
  },
  dota2: {
    label: "Dota 2 (5v5 fantasy MOBA)",
    scene:
      "high-fantasy battle arena, armoured fantasy heroes and arcane spellcasters mid-cast, glowing magical energy and elemental spell effects, ancient stone towers and a river-split forest lane, radiant gold versus shadowy corruption",
  },
  "dota2-duels": {
    label: "Dota 2 duels (1v1 mid lane)",
    scene:
      "two fantasy heroes duelling in a single stone-flagged mid lane, arcane bolts colliding mid-air, ancient towers flanking, moody forest fog",
  },
  lol: {
    label: "League of Legends (5v5 fantasy MOBA)",
    scene:
      "stylised fantasy champions in ornate armour, vivid magical ability effects, enchanted forest lane with crystal turrets, painterly high-saturation fantasy illustration",
  },
  valorant: {
    label: "Valorant (tactical 5v5 hero shooter)",
    scene:
      "stylised tactical agents with distinct silhouettes, pistol and rifle poses, colourful elemental ability effects (smoke walls, fire, ice) cutting through a clean modern map, crisp graphic-novel lighting",
  },
  overwatch: {
    label: "Overwatch (6v6 hero shooter)",
    scene:
      "bright near-future hero shooter characters with exaggerated silhouettes, energy weapons and shield barriers, clean optimistic sci-fi architecture, saturated primary colours",
  },
  "apex-legends": {
    label: "Apex Legends (battle-royale hero shooter)",
    scene:
      "battle-royale skirmishers in armoured jumpsuits, energy rifles, wide alien canyon vista with drop-ship contrails, dusk gradient sky",
  },
  r6: {
    label: "Rainbow Six Siege (tactical breach shooter)",
    scene:
      "counter-terrorist breach team in heavy tactical gear and gas masks, reinforced interior walls, shattered drywall dust, flashlight beams in gloom",
  },
  pubg: {
    label: "PUBG (battle royale)",
    scene:
      "military-surplus battle-royale survivors, level-3 helmets and backpacks, abandoned rural buildings and open grassland, overcast realistic daylight",
  },
  "pubg-mobile": {
    label: "PUBG Mobile (battle royale)",
    scene:
      "battle-royale survivors with rifles and backpacks, abandoned rural compound, wide grassland horizon, overcast light",
  },
  fortnite: {
    label: "Fortnite (build-battle battle royale)",
    scene:
      "vibrant cartoon-stylised battle-royale characters, improvised ramp structures mid-build, saturated candy-coloured island landscape, playful cel-shaded look",
  },
  "free-fire": {
    label: "Free Fire (mobile battle royale)",
    scene:
      "mobile battle-royale survivors with light weapons, tropical island compound, bright high-contrast sunlight",
  },
  cod: {
    label: "Call of Duty (military shooter)",
    scene:
      "modern-warfare soldiers in plate carriers and NVG mounts, urban rubble and burning vehicles, gritty desaturated film-grain war photography look",
  },
  crossfire: {
    label: "CrossFire (tactical shooter)",
    scene:
      "tactical shooter operatives, close-quarters industrial map, muzzle flash and dust",
  },
  "marvel-rivals": {
    label: "Marvel Rivals (hero shooter)",
    scene:
      "comic-book superheroes mid-flight and mid-punch, energy blasts and debris, dramatic four-colour comic lighting, crumbling city rooftop",
  },
  ml: {
    label: "Mobile Legends (mobile MOBA)",
    scene:
      "mobile-MOBA fantasy heroes in ornate armour, bright ability effects, three-lane fantasy arena, high-saturation stylised look",
  },
  aov: {
    label: "Arena of Valor (mobile MOBA)",
    scene:
      "mobile-MOBA fantasy champions, glowing skill effects, jungle-and-tower arena, vivid stylised fantasy",
  },
  kog: {
    label: "King of Glory (mobile MOBA)",
    scene:
      "wuxia-flavoured fantasy MOBA heroes, silk robes and jade weapons, glowing chi effects, ornate oriental arena architecture",
  },
  sc2: {
    label: "StarCraft II (1v1 sci-fi RTS)",
    scene:
      "vast sci-fi battlefield seen wide, power-armoured marines, insectoid alien swarms and psionic energy, mineral fields and command structures, cinematic space-opera scale",
  },
  sc1: {
    label: "StarCraft (1v1 sci-fi RTS)",
    scene:
      "retro sci-fi RTS battlefield, power-armoured infantry versus alien swarm, industrial mining outpost, gritty space-opera palette",
  },
  w3: {
    label: "Warcraft III (fantasy RTS)",
    scene:
      "fantasy RTS battlefield, orcish and human armies clashing, siege engines and arcane towers, painted high-fantasy look",
  },
  aoe: {
    label: "Age of Empires (historical RTS)",
    scene:
      "medieval historical battlefield, massed pikemen and cavalry, trebuchets and stone castle walls, warm painterly historical illustration",
  },
  wot: {
    label: "World of Tanks (armoured warfare)",
    scene:
      "WWII-era heavy tanks manoeuvring through mud and shattered treelines, engine smoke, cold overcast wartime palette",
  },
  rocketleague: {
    label: "Rocket League (car football)",
    scene:
      "rocket-powered cars mid-air with neon boost trails, oversized football, enclosed futuristic stadium pitch, glossy high-energy arcade look",
  },
  chess: {
    label: "chess",
    scene:
      "dramatic close-up of carved chess pieces on a board, king and queen looming, hard directional light and long shadows, marble and wood textures",
  },
  "street-fighter": {
    label: "Street Fighter (1v1 fighting game)",
    scene:
      "two martial artists mid-clash, impact shockwave between their fists, exaggerated comic fighting-game energy, vivid stage backdrop",
  },
  tekken: {
    label: "Tekken (1v1 3D fighting game)",
    scene:
      "two 3D fighters mid-combo, motion-blurred limbs and impact sparks, dramatic arena stage lighting",
  },
  etouchdown: {
    label: "virtual American football",
    scene:
      "American-football players mid-tackle in full pads and helmets, floodlit stadium turf, grass and chalk dust in the air",
  },
  efootball: {
    label: "virtual football (soccer)",
    scene:
      "footballers mid-strike on a floodlit pitch, ball frozen in flight, packed stadium bokeh behind, crisp broadcast-sports look",
  },
  ebasketball: {
    label: "virtual basketball",
    scene:
      "basketball players mid-dunk at the rim, polished hardwood court reflections, arena spotlights and crowd bokeh",
  },
  ecricket: {
    label: "virtual cricket",
    scene:
      "cricket batsman mid-shot with the ball in flight, floodlit oval pitch, whites against green turf",
  },
};

const FALLBACK: GameVocab = {
  label: "competitive esports",
  scene:
    "professional esports players at tournament stations, glowing monitors and peripherals, packed darkened arena with stage lighting",
};

export function gameVocab(sportSlug: string | null): GameVocab {
  if (!sportSlug) return FALLBACK;
  return VOCAB[sportSlug] ?? FALLBACK;
}
