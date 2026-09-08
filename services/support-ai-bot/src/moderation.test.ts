import test from "node:test";
import assert from "node:assert/strict";
import { classifyBettorMessage, normalise } from "./moderation.js";

const abusive = (s: string): void =>
  assert.equal(classifyBettorMessage(s), "abusive", `expected abusive: ${s}`);
const clean = (s: string): void =>
  assert.equal(classifyBettorMessage(s), "clean", `expected clean: ${s}`);

test("fires on abuse aimed at the assistant", () => {
  abusive("fuck you");
  abusive("Fuck you!!!");
  abusive("fuck off you useless bot");
  abusive("you are a fucking idiot");
  abusive("you're a clown");
  abusive("shut the fuck up");
  abusive("ur a moron");
  abusive("you pathetic scam artists");
});

test("fires on Russian abuse aimed at the assistant", () => {
  abusive("иди нахуй");
  abusive("иди на хуй");
  abusive("пошли вы");
  abusive("ты дебил");
  abusive("вы мудаки");
  abusive("заткнись");
  abusive("ты тупая сука");
});

test("fires on abuse in the other storefront languages", () => {
  // es
  abusive("vete a la mierda");
  abusive("eres un gilipollas");
  abusive("sois unos putos inutiles");
  // pt
  abusive("vai se foder");
  abusive("voce e um otario");
  abusive("seu babaca");
  // cs
  abusive("jdi do prdele");
  abusive("jsi debil");
  abusive("vy kokoti");
  // hr
  abusive("jebi se");
  abusive("ti si kreten"); // "ti" + "kreten" within the window
  abusive("vi ste budale");
});

test("distress vetoes in every language, not just en/ru", () => {
  // The half that must not be forgotten when a language is added: these
  // all carry abuse AND a distress marker, and the veto has to win.
  clean("soy ludopata y lo perdi todo, sois unos putos");
  clean("no puedo parar de jugar, vete a la mierda");
  clean("perdi tudo, voce e um otario");
  clean("nao consigo parar de jogar, vai se foder");
  clean("jsem zavisly, jdi do prdele");
  clean("nemuzu prestat hrat, jsi debil");
  clean("imam ovisnost, jebi se");
  clean("izgubio sam sve, vi ste budale");
});

test("does not fire on ordinary questions in those languages", () => {
  clean("hola, cuando juega NAVI?");
  clean("puedes decirme por que perdio mi apuesta?");
  clean("ola, como faco para sacar?");
  clean("dobry den, kdy hraje Spirit?");
  clean("kada igra Vitality?");
  // The Portuguese article "os" and the Spanish "si" are why those two
  // were left out of the second-person set.
  clean("os jogos de hoje estao uma merda");
  clean("si, esta mierda no funciona");
  // ...and why Croatian "vi" is out: it is "I saw" in es/pt.
  clean("vi que a merda do site nao funciona");
  clean("ayer vi una mierda de cuota en ese partido");
});

test("does NOT fire on frustration that is not aimed at anyone", () => {
  // The single most common false positive: the words are all there, but
  // the swear is about the situation and is nowhere near the "you".
  clean("what the fuck happened to my bet, can you check it please");
  clean("this is fucking ridiculous, my withdrawal is still pending");
  clean("the odds are shit today");
  clean("бля, ставка не прошла, можете проверить");
  clean("какого хуя не работает вывод средств");
});

test("does NOT fire on a distress message, even a profane one", () => {
  // The case that matters most. Every one of these carries a distress
  // marker, so the veto runs before any targeting rule and the assistant
  // answers with the supportive path its prompt commits it to.
  clean("i've lost everything on this fucking site, you people are scum");
  clean("fuck you, i can't stop gambling and i've lost it all");
  clean("i think i have a gambling problem, you fucking enablers");
  clean("i want to self exclude, your fucking site ruined me");
  clean("я лудоман, вы суки меня разорили");
  clean("не могу остановиться, помогите, вы твари");
  clean("i spent my rent money, you idiots");
});

test("does not fire on ordinary support questions", () => {
  clean("hi, when does NAVI play next?");
  clean("can you tell me why my combo lost?");
  clean("how do I withdraw USDC?");
  clean("");
  clean("   ");
  clean("Are you a bot?");
  clean("thank you, you were very helpful");
});

test("does not fire on a bare untargeted shout", () => {
  // Frustration, not abuse of a person. Conservative on purpose: a false
  // positive here insults a customer who did nothing wrong.
  clean("FUCK!!!");
  clean("блять");
  clean("shit shit shit");
});

test("sees through light obfuscation and letter-stretching", () => {
  abusive("fuuuuck you");
  abusive("fck you");
  abusive("fuk you");
  abusive("y0u are an idiot");
  // Not covered, and deliberately so: `4` is standardly `a`, so "f4ck"
  // normalises to "fack". Chasing every substitution is an adversarial
  // filter, and the cost of a miss is only that a rude bettor gets the
  // ordinary helpful answer.
  clean("f4ck you");
});

test("proximity window is what separates the two cases", () => {
  // Same two words, different distance apart.
  abusive("you fucking muppets");
  clean(
    "i had a fucking terrible run this week and was wondering whether you " +
      "could look at my last five tickets",
  );
});

test("normalise keeps Cyrillic and drops punctuation", () => {
  assert.equal(normalise("Fuck YOU!!!"), "fuck you");
  assert.equal(normalise("иди  нахуй..."), "иди нахуй");
  assert.equal(normalise("---"), "");
});
