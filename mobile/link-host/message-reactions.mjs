export function setReaction(message, emoji, actor) {
  if (typeof emoji !== "string" || emoji.length > 64 || !/^(?:\p{RGI_Emoji}|\p{Extended_Pictographic})$/v.test(emoji) || emoji.trim() !== emoji)
    throw new Error("Choose one emoji to react.");
  const others = (message.reactions ?? []).filter((reaction) => reaction.actor !== actor);
  message.reactions = [...others, { actor, emoji }];
}
