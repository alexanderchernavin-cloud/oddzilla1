// Per-game visual vocabulary, keyed by sport slug.
//
// Two fields, and the split matters:
//
//   scene — WHAT is in the frame (subjects, place, props).
//   style — HOW that title actually looks: its real art direction, the
//           renderer it ships in, its palette discipline.
//
// `scene` exists because the local LLM does NOT reliably know what these
// games look like. Left to its own knowledge it produced tactical-shooter
// soldiers holding melee weapons for a DOTA 2 match (observed
// 2026-08-28) — the "esports arena + soldiers" attractor swallows every
// title.
//
// `style` exists because "make it look like premium esports promo art"
// is what produced the slop: airbrushed neon, purple rim light, plastic
// skin, haze over everything, the same picture for all 32 titles. A
// banner only convinces when it looks like the GAME — CS2 reads as a
// grounded Source 2 frame, Dota as Valve painted key art, Valorant as
// flat and graphic. So art direction is supplied as ground truth too,
// and appended to the prompt deterministically so the LLM cannot drop
// it or dilute it back into "cinematic".
//
// Both fields deliberately avoid trademarked character and logo names —
// they describe the title's visual language, not its IP. Real crests and
// real team names are composited onto the finished plate afterwards
// (see compose.ts), which is the only way to get either of them crisp.

export interface GameVocab {
  /** Human name for the prompt's framing sentence. */
  label: string;
  /** What is physically in the frame. */
  scene: string;
  /** The title's real art direction — appended verbatim to every prompt. */
  style: string;
}

const VOCAB: Record<string, GameVocab> = {
  cs2: {
    label: "Counter-Strike 2 (tactical 5v5 bomb-defusal shooter)",
    scene:
      "counter-terrorist operators in plain matte tactical vests, gloves and helmets, assault rifles shouldered, crossing a sunlit Mediterranean bomb site of sand-coloured stone walls, wooden crates and a dusty courtyard, thin smoke drifting low",
    style:
      "looks like a Counter-Strike 2 Source 2 frame: grounded military realism, hard midday sun with clean shadows, sand and concrete and olive palette, matte fabric and gunmetal, no stylisation",
  },
  "cs2-duels": {
    label: "Counter-Strike 2 duels (1v1 aim duel)",
    scene:
      "two lone operators facing each other down a narrow concrete corridor, rifles raised, dust hanging in one hard shaft of daylight from a broken skylight",
    style:
      "looks like a Counter-Strike 2 Source 2 frame: grounded military realism, hard daylight, concrete and gunmetal palette, no stylisation",
  },
  dota2: {
    label: "Dota 2 (5v5 fantasy MOBA)",
    scene:
      "armoured fantasy warriors and robed spellcasters meeting in a stone-flagged lane between ancient towers, a spell discharging between them, a river and dense forest behind, siege creeps advancing",
    style:
      "looks like official Dota 2 key art: painted realism over chunky readable silhouettes, heavy ornate armour with visible wear, warm gold against cold green shadow, magic light sourced from the spell itself",
  },
  "dota2-duels": {
    label: "Dota 2 duels (1v1 mid lane)",
    scene:
      "two fantasy heroes trading blows in a single stone mid lane, an arcane bolt breaking against a raised shield, ancient towers flanking them, forest mist behind",
    style:
      "looks like official Dota 2 key art: painted realism, chunky readable silhouettes, ornate worn armour, warm gold against cold green shadow",
  },
  lol: {
    label: "League of Legends (5v5 fantasy MOBA)",
    scene:
      "fantasy champions in ornate plate and cloth mid-fight on a forest lane, one loosing an ability, crystalline turret and jungle brush behind",
    style:
      "looks like Riot splash art: confident painterly brushwork, clean strong silhouettes, saturated but controlled colour, storybook fantasy rather than photoreal",
  },
  valorant: {
    label: "Valorant (tactical 5v5 hero shooter)",
    scene:
      "tactical agents with distinct silhouettes holding pistols and rifles across a clean modern map, a coloured ability wall of smoke or ice cutting the space in half",
    style:
      "looks like Valorant in-game art: flat graphic shading, crisp hard edges, bright even light, bold blocked colour with almost no grain or haze",
  },
  overwatch: {
    label: "Overwatch (6v6 hero shooter)",
    scene:
      "near-future heroes with exaggerated silhouettes advancing on an objective, an energy shield up, clean optimistic sci-fi architecture around them",
    style:
      "looks like Overwatch in-game art: clean stylised 3D, bright even light, saturated primary colours, smooth surfaces, no grit",
  },
  "apex-legends": {
    label: "Apex Legends (battle-royale hero shooter)",
    scene:
      "armoured skirmishers in jumpsuits moving along a canyon ridge, energy rifles up, a dropship contrail across a dusk sky",
    style:
      "looks like Apex Legends in-game art: stylised near-future realism, warm dusk light, orange rock against teal sky, clean readable armour panels",
  },
  r6: {
    label: "Rainbow Six Siege (tactical breach shooter)",
    scene:
      "a breach team in heavy gear and gas masks stacked at a reinforced doorway, drywall dust in the air, flashlight beams crossing a gloomy interior",
    style:
      "looks like Rainbow Six Siege in-game footage: sober tactical realism, desaturated interior light, matte gear, heavy shadow, no glamour",
  },
  pubg: {
    label: "PUBG (battle royale)",
    scene:
      "survivors in level-three helmets and backpacks crossing open grassland toward an abandoned farm compound",
    style:
      "looks like PUBG in-game footage: plain photographic realism, flat overcast daylight, muted green and grey, no colour grading",
  },
  "pubg-mobile": {
    label: "PUBG Mobile (battle royale)",
    scene:
      "survivors with rifles and backpacks moving through an abandoned rural compound, wide grassland horizon behind",
    style:
      "looks like PUBG Mobile in-game footage: clean realism at mobile fidelity, flat overcast daylight, muted green and grey",
  },
  fortnite: {
    label: "Fortnite (build-battle battle royale)",
    scene:
      "cartoon-proportioned characters mid build-fight, timber ramps going up around them, a bright island landscape of green hills and candy-coloured buildings behind",
    style:
      "looks like Fortnite in-game art: clean cel-shaded 3D, bright flat daylight, high-saturation primaries, smooth plastic surfaces, no grit and no haze",
  },
  "free-fire": {
    label: "Free Fire (mobile battle royale)",
    scene:
      "survivors with light weapons taking cover behind a concrete wall in a tropical island compound, palms behind",
    style:
      "looks like Free Fire in-game art: bright high-contrast mobile 3D, hard tropical sunlight, saturated colour",
  },
  cod: {
    label: "Call of Duty (military shooter)",
    scene:
      "soldiers in plate carriers and helmet mounts advancing past a burning vehicle through urban rubble",
    style:
      "looks like Call of Duty in-game footage: gritty photographic realism, desaturated grade, fine film grain, smoke and dust doing the atmospheric work",
  },
  crossfire: {
    label: "CrossFire (tactical shooter)",
    scene:
      "two operatives trading fire across an industrial warehouse floor, muzzle flash lighting the dust",
    style:
      "looks like CrossFire in-game footage: straightforward shooter realism, industrial greys, hard practical lighting",
  },
  "marvel-rivals": {
    label: "Marvel Rivals (hero shooter)",
    scene:
      "costumed superheroes mid-flight and mid-punch above a crumbling rooftop, debris and an energy blast between them",
    style:
      "looks like Marvel Rivals in-game art: stylised comic-book 3D, bold ink-clean silhouettes, four-colour palette, clear rim separation",
  },
  ml: {
    label: "Mobile Legends (mobile MOBA)",
    scene:
      "fantasy heroes in ornate armour clashing at a lane tower, an ability arc between them, three-lane arena terrain behind",
    style:
      "looks like Mobile Legends splash art: glossy stylised fantasy illustration, high saturation, clean silhouettes",
  },
  aov: {
    label: "Arena of Valor (mobile MOBA)",
    scene:
      "fantasy champions mid-skirmish beside a jungle tower, a skill effect breaking between them",
    style:
      "looks like Arena of Valor splash art: glossy stylised fantasy illustration, vivid saturated colour, clean silhouettes",
  },
  kog: {
    label: "King of Glory (mobile MOBA)",
    scene:
      "wuxia heroes in silk robes with jade-inlaid weapons mid-duel on an ornate lane bridge, chi energy trailing a blade",
    style:
      "looks like King of Glory splash art: painted wuxia fantasy illustration, silk and jade palette, elegant flowing motion",
  },
  sc2: {
    label: "StarCraft II (1v1 sci-fi RTS)",
    scene:
      "a wide battlefield seen from above and behind: power-armoured marines holding a line against an insectoid swarm, mineral fields and command structures behind them",
    style:
      "looks like a StarCraft II in-game camera view: readable RTS scale with units small in frame, functional sci-fi industrial design, sober palette",
  },
  sc1: {
    label: "StarCraft (1v1 sci-fi RTS)",
    scene:
      "power-armoured infantry dug in against an alien swarm across a mining outpost, seen wide",
    style:
      "looks like a StarCraft in-game camera view: readable RTS scale, gritty industrial sci-fi, sober palette",
  },
  w3: {
    label: "Warcraft III (fantasy RTS)",
    scene:
      "orcish and human battle lines meeting on open ground, siege engines rolling up behind, an arcane tower on the flank",
    style:
      "looks like Warcraft III art: painted high fantasy, exaggerated chunky proportions, warm saturated colour",
  },
  aoe: {
    label: "Age of Empires (historical RTS)",
    scene:
      "massed pikemen and cavalry meeting below a stone castle wall, a trebuchet loosing behind the line",
    style:
      "looks like Age of Empires art: warm painterly historical illustration, earthy palette, clear readable formations",
  },
  wot: {
    label: "World of Tanks (armoured warfare)",
    scene:
      "WWII heavy tanks manoeuvring through churned mud and shattered treeline, exhaust smoke trailing",
    style:
      "looks like World of Tanks in-game footage: sober mechanical realism, riveted steel and mud, cold overcast light, no colour grading",
  },
  rocketleague: {
    label: "Rocket League (car football)",
    scene:
      "rocket-powered cars mid-air converging on an oversized ball inside an enclosed pitch",
    style:
      "looks like Rocket League in-game footage: clean arcade 3D, glossy car paint, bright even arena light, simple saturated colour",
  },
  chess: {
    label: "chess",
    scene:
      "carved chess pieces at close range on a board mid-game, king and queen dominant, opposing pieces receding out of focus",
    style:
      "a photographic still life: real marble and wood texture, one soft window light, quiet neutral palette, no effects",
  },
  "street-fighter": {
    label: "Street Fighter (1v1 fighting game)",
    scene:
      "two martial artists mid-clash, a shockwave breaking where their strikes meet, a detailed street stage behind",
    style:
      "looks like Street Fighter in-game art: bold stylised 3D, thick readable silhouettes, saturated stage colour, exaggerated impact",
  },
  tekken: {
    label: "Tekken (1v1 3D fighting game)",
    scene:
      "two fighters mid-combo, one absorbing a hit, impact sparks between them on a stage floor",
    style:
      "looks like Tekken in-game art: polished character 3D with realistic proportions, hard stage lighting, clean surfaces",
  },
  etouchdown: {
    label: "virtual American football",
    scene:
      "a running back mid-tackle in full pads and helmet, turf and chalk dust kicking up under floodlights",
    style:
      "looks like a sports-sim broadcast frame: television realism, even floodlight, accurate turf and kit texture, no grade",
  },
  efootball: {
    label: "virtual football (soccer)",
    scene:
      "a footballer striking the ball on a floodlit pitch, the ball frozen just off the boot, the far stand out of focus behind",
    style:
      "looks like a football-sim broadcast frame: television realism, even floodlight, accurate grass and kit texture, no grade",
  },
  ebasketball: {
    label: "virtual basketball",
    scene:
      "a player rising to the rim past a defender, polished hardwood reflecting the arena lights below",
    style:
      "looks like a basketball-sim broadcast frame: television realism, even arena light, accurate court and kit texture",
  },
  ecricket: {
    label: "virtual cricket",
    scene:
      "a batsman completing a shot with the ball in flight, floodlit oval turf, whites against green",
    style:
      "looks like a cricket-sim broadcast frame: television realism, even floodlight, accurate turf and kit texture",
  },
};

const FALLBACK: GameVocab = {
  label: "competitive esports",
  scene:
    "professional players at tournament stations on a stage, hands on keyboards, screens glowing in front of them, a darkened hall behind",
  style:
    "photographic event coverage: real stage lighting, accurate skin and fabric, natural colour, no effects",
};

export function gameVocab(sportSlug: string | null): GameVocab {
  if (!sportSlug) return FALLBACK;
  return VOCAB[sportSlug] ?? FALLBACK;
}
