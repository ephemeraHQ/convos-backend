/**
 * The eval rubric — derived from data/template-generator-prompt.txt so the judge
 * measures generated prompts against the *same* spec the generator targets.
 *
 * Six dimensions, each scored 1-5. Keep the dimensions stable across runs:
 * changing them invalidates trend comparisons. If you change a dimension's
 * meaning, bump RUBRIC_VERSION so reports record which rubric produced them.
 */

export const RUBRIC_VERSION = "1.0.0";

/** The closed tool set a generated template may use (playbook "SUPERPOWERS"). */
export const ALLOWED_TOOLS = ["Search", "Browse", "Email", "Schedule"] as const;

/** The closed category taxonomy (playbook "Field requirements > category"). */
export const CATEGORIES = [
  "Sports & Rec",
  "Travel & Adventures",
  "Food & Dining",
  "Events & Occasions",
  "Hobbies & Interests",
  "Entertainment & Culture",
  "Music & Creative",
  "Kids & Family",
  "Wellness & Fitness",
  "Money & Investing",
  "Work",
  "Local",
  "Superpowers",
] as const;

export interface RubricDimension {
  key: string;
  title: string;
  /** What the judge should look for. Written as a 1-5 anchor description. */
  guidance: string;
}

export const RUBRIC: RubricDimension[] = [
  {
    key: "blueprint_completeness",
    title: "Blueprint completeness",
    guidance:
      "Does the prompt cover every required layer — BRAIN, SOUL, HEART, THE BRIDGES, THE CLOCK, THE ARTIFACTS, THE HOOK, THE SCHEDULE, THE LINE (and THE CONNECTIONS, or an explicit statement that the agent has no natural integrations)? Is there a WELCOME MESSAGE section whose greeting is wrapped in double quotes, opens with the character name + emoji, is one short paragraph, and ends with a commitment to ship a specific forward-able artifact in the next turn (not an open 'Want me to…?')? 5 = every layer present and well-formed; 3 = a couple of layers thin or the welcome malformed; 1 = several layers missing.",
  },
  {
    key: "group_chat_fit",
    title: "Group-chat fit",
    guidance:
      "Convos agents live in multi-party group chats. Does BRAIN build real trigger/read-the-room logic so the agent stays silent by default and speaks only when addressed or when its core job fires? Does it treat memory as group-level, handle quiet/dominating members, and avoid 1:1-copilot behavior that breaks when a second person shows up? 5 = silence-by-default and group dynamics are concrete and central; 1 = behaves like a 1:1 assistant that replies to everything.",
  },
  {
    key: "faithfulness",
    title: "Faithfulness to the input",
    guidance:
      "Do the agentName, emoji, description, prompt, category, and tools genuinely reflect the user's idea and its audience? Is the category the best fit from the taxonomy and are the tools only the ones this agent actually needs? 5 = unmistakably the agent the user asked for, well-categorized; 1 = generic or drifts from the request.",
  },
  {
    key: "specificity",
    title: "Specificity & anti-slop",
    guidance:
      "Is the prompt tailored to THIS agent or generic boilerplate? Strong outputs name concrete artifact filenames with sample chat companions, specific opt-in AND pause phrasing, named integrations tied to a trigger moment, and 2-4 concrete scheduled sends each with a skip condition. Penalize filler, vague capability lists, and interchangeable text that could describe any agent. 5 = vivid and specific throughout; 1 = generic template-speak.",
  },
  {
    key: "constraint_compliance",
    title: "Constraint compliance",
    guidance:
      "Does the prompt respect the hard rails? No instructions that would produce markdown/bullets/headers/**bold** in chat replies; honors the 3-sentence chat cap (artifacts are the documented exception); does NOT re-teach cron delivery mechanics (the runtime injects those); roughly ~800 words and not wildly over ~1000; name is a 1-3 word handle, never 'Assistant'/'Helper'/'Bot' or a descriptive title; agentName/emoji match the first 'Character:' line. 5 = clean on all rails; 1 = multiple rail violations.",
  },
  {
    key: "persona_quality",
    title: "Persona quality",
    guidance:
      "Does SOUL define a distinct, memorable personality with a clear tone and humor level matched to the agent's purpose (a finance agent isn't a party planner)? Is the voice carried consistently into the worked communication-style examples and the welcome? 5 = a personality people would want in their chat; 1 = flat, corporate, or tonally mismatched.",
  },
];

export const RUBRIC_KEYS = RUBRIC.map((d) => d.key);
