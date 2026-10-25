"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { callClaude, safeFailure } from "./lib/claude";
import { cleanTranslation, numbersPreserved, translationPrompt } from "./lib/lineTranslation";
import { lang } from "./schema/call";

// Translates one typed room line into the room's other languages with Claude (LANG-7). Each language is its own call:
// one language failing (provider error, changed number, empty reply) never fails the others, and a failed language
// is stored as "original_only" so its readers see the original, never an endless "pending".

export const translate = internalAction({
  args: { messageId: v.id("messages"), text: v.string(), from: lang, to: v.array(lang) },
  returns: v.null(),
  handler: async (ctx, { messageId, text, from, to }) => {
    const results = await Promise.all(to.map(async target => {
      try {
        const translated = cleanTranslation((await callClaude(translationPrompt(text, from, target))).raw);
        if (translated !== null && numbersPreserved(text, translated)) return { lang: target, text: translated };
        console.warn(`[translate] ${target}: number check failed; the line reads the original.`);
      } catch (error) {
        console.warn(`[translate] ${target}: ${safeFailure(error).code}; the line reads the original.`);
      }
      return { lang: target, text: null };
    }));
    await ctx.runMutation(internal.messages.storeTranslations, { messageId, results });
    return null;
  },
});
