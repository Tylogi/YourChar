export function hasExplicitArrivalEvidence(
  userText: string,
  location: string | undefined,
  hasPendingMeeting: boolean,
): boolean {
  const text = normalize(userText);
  if (!text || looksProspective(text) || looksLikeQuestion(text)) return false;
  if (/\b(?:i(?:'m| am) here|i(?:'ve| have) arrived)\b/iu.test(text)) {
    return hasPendingMeeting || Boolean(location && mentions(text, location));
  }
  if (/\bi(?:'m| am) at\b/iu.test(text)) {
    return hasPendingMeeting || Boolean(location && mentions(text, location));
  }
  if (/(?:^|[，。！？!?\s])(?:我)?(?:已经|刚刚|刚|现在)?(?:到了|到啦|到咯|来了|来啦)(?:[，。！？!?\s]|$)/u.test(text)) {
    return hasPendingMeeting || Boolean(location && mentions(text, location));
  }
  if (/(?:我)(?:已经|刚刚|刚|现在)?(?:到|到达|来到|走到|进到).{0,40}(?:了|啦|咯)(?:[，。！？!?\s]|$)/u.test(text)) {
    return hasPendingMeeting || Boolean(location && mentions(text, location));
  }
  if (/(?:我)(?:已经|现在|正)?(?:在|就在)(?:这里|这儿|现场|门口|楼下|外面)(?:[，。！？!?\s]|$)/u.test(text)) {
    return hasPendingMeeting;
  }
  return Boolean(location && mentions(text, location) && /(?:我).{0,8}(?:在|到了|到达|来到|进了|来了)/u.test(text));
}

/**
 * The model performs the positive semantic decision for meeting transitions.
 * Keep only a narrow deterministic veto for messages that clearly contradict
 * immediate co-presence; a positive keyword allowlist rejects valid actions
 * such as opening the door or returning to an ongoing scene.
 */
export function contradictsImmediateCoPresence(userText: string): boolean {
  const text = normalize(userText);
  return !text || looksProspective(text) || looksLikeQuestion(text);
}

function looksProspective(text: string): boolean {
  return /(?:还没|没有|尚未|未)(?:到|来)|(?:快|马上|就快|差不多)(?:到|到了)|(?:准备|打算|想|要|会)(?:去|到|来)|(?:等我|等到我)(?:到|来)/u.test(text);
}

function looksLikeQuestion(text: string): boolean {
  return /[?？]\s*$/u.test(text) || /(?:到了吗|到了么|到哪了|是不是到了)/u.test(text);
}

function mentions(text: string, location: string): boolean {
  const target = normalize(location).replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）]/gu, "");
  const source = text.replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）]/gu, "");
  return target.length >= 2 && source.includes(target);
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().toLocaleLowerCase();
}
