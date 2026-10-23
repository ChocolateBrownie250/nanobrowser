// Request schemas of the protocol. Every request is plain JSON, so a later MCP bridge can forward calls unchanged and
// generate its tool definitions from these schemas.
import { z } from 'zod';

const ref = z.string().min(1).max(64).describe('A ref from the latest observation, such as "e12"');

// Upper bounds on what an agent may send, so one call cannot hold a tab's lock for minutes or fill the worker's memory.
/** Text typed key by key: every character holds the tab's lock, so the bound keeps one call from running for minutes. */
const MAX_TEXT = 20_000;
/** A value set into a field in one command (and the value an expectation compares), as large as a `read` returns. */
const MAX_VALUE = 200_000;
/** Names, roles, search strings, selectors and expectations. */
const MAX_STRING = 2_000;
/** An address (the common limit for a URL). */
const MAX_URL = 8_192;
/** The largest attached file is 25 MiB (store/attachments MAX_FILE), which is 34 952 536 base64 characters. */
const MAX_BASE64 = 35_000_000;
const MAX_FIELDS = 50;

/** The value of a field: text, a checkbox state, or the options chosen in a list. */
const fieldValue = z.union([z.string().max(MAX_VALUE), z.boolean(), z.array(z.string().max(MAX_VALUE)).max(100)]);

export const RefTargetSchema = z.strictObject({ ref });
export const SemanticTargetSchema = z.strictObject({
  role: z.string().min(1).max(MAX_STRING).describe('Accessibility role, such as "button" or "link"'),
  name: z
    .string()
    .max(MAX_STRING)
    .optional()
    .describe('Accessible name; matched exactly after whitespace is collapsed'),
  nth: z.number().int().min(0).optional().describe('Zero-based index among the matches, in document order'),
  within: ref.optional().describe('Only match inside the element with this ref'),
});
export const SelectorTargetSchema = z.strictObject({
  selector: z.string().min(1).max(MAX_STRING).describe('CSS selector (capability "selector")'),
});
export const PointTargetSchema = z.strictObject({
  x: z.number().describe('CSS pixels of the last screenshot (capability "vision")'),
  y: z.number(),
});
export const TargetSchema = z
  .union([RefTargetSchema, SemanticTargetSchema, SelectorTargetSchema, PointTargetSchema])
  .describe('The element to act on: a ref, or a role and name that must match exactly one element');

export const ExpectationSchema = z
  .strictObject({
    url: z.string().max(MAX_STRING).optional().describe('The page URL contains this text'),
    text: z.string().max(MAX_STRING).optional().describe('This text is on the page'),
    textGone: z.string().max(MAX_STRING).optional().describe('This text is no longer on the page'),
    value: z.string().max(MAX_VALUE).optional().describe("The target's value equals this"),
    checked: z.boolean().optional().describe('The target is checked (true) or unchecked (false)'),
    gone: z.boolean().optional().describe('The target is no longer in the page'),
  })
  .describe('A postcondition checked after the action settles');

export const ObserveSchema = z.enum(['none', 'diff', 'full']).describe('Page state to return with the result');

const readCommon = {
  tabId: z.number().int().optional().describe("Default: the session's active tab"),
  intent: z
    .string()
    .max(500)
    .optional()
    .describe('Human-readable purpose, shown to the user and kept in the audit log'),
  // Positive: Puppeteer reads a navigation timeout of 0 as no deadline at all.
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
};
const actionCommon = {
  ...readCommon,
  expect: ExpectationSchema.optional(),
  observe: ObserveSchema.optional(),
};

export const SnapshotArgsSchema = z.strictObject({
  ...readCommon,
  scope: ref.optional().describe('Only the subtree of this ref'),
  mode: z
    .enum(['interactive', 'all'])
    .optional()
    .describe('"interactive" prints only actionable elements and their containers'),
  window: z.enum(['viewport', 'near', 'page']).optional().describe('How much of the page to print'),
});

export const FindArgsSchema = z.strictObject({
  ...readCommon,
  role: z.string().max(MAX_STRING).optional(),
  name: z.string().max(MAX_STRING).optional().describe('Substring of the accessible name, case-insensitive'),
  text: z.string().max(MAX_STRING).optional().describe('Substring of the element’s name or value, case-insensitive'),
  within: ref.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const ReadArgsSchema = z.strictObject({
  ...readCommon,
  ref: ref.optional().describe('Only the content of this element'),
  format: z.enum(['markdown', 'text']).default('markdown'),
  maxChars: z.number().int().min(100).max(200_000).optional(),
  offset: z.number().int().min(0).optional().describe('Character offset to continue from'),
});

export const ScreenshotArgsSchema = z.strictObject({
  ...readCommon,
  ref: ref.optional().describe('Only this element'),
  fullPage: z.boolean().optional(),
  labels: z.boolean().optional().describe('Draw ref labels over actionable elements'),
});

export const ClickArgsSchema = z.strictObject({
  ...actionCommon,
  target: TargetSchema,
  button: z.enum(['left', 'right', 'middle']).optional(),
  count: z.number().int().min(1).max(3).optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
});

export const SetArgsSchema = z.strictObject({
  ...actionCommon,
  target: TargetSchema,
  value: fieldValue,
  submit: z.boolean().optional().describe('Press Enter after setting the value'),
});

export const FillFormArgsSchema = z.strictObject({
  ...actionCommon,
  fields: z
    .array(z.strictObject({ target: TargetSchema, value: fieldValue }))
    .min(1)
    .max(MAX_FIELDS),
  submit: TargetSchema.optional().describe('Activate this element after every field is set'),
});

export const TypeArgsSchema = z.strictObject({
  ...actionCommon,
  text: z.string().max(MAX_TEXT),
  target: TargetSchema.optional(),
  submit: z.boolean().optional(),
});

export const PressArgsSchema = z.strictObject({
  ...actionCommon,
  keys: z.string().min(1).max(MAX_STRING).describe('A key or chord, such as "Enter", "Escape" or "Control+A"'),
  target: TargetSchema.optional(),
});

export const HoverArgsSchema = z.strictObject({ ...actionCommon, target: TargetSchema });

export const ScrollArgsSchema = z.strictObject({
  ...actionCommon,
  target: TargetSchema.optional().describe('The container to scroll; default: the page'),
  to: z.union([z.enum(['top', 'bottom']), TargetSchema]).optional(),
  by: z.strictObject({ pages: z.number().optional(), px: z.number().optional() }).optional(),
});

export const WaitArgsSchema = z.strictObject({
  ...readCommon,
  observe: ObserveSchema.optional(),
  text: z.string().max(MAX_STRING).optional(),
  textGone: z.string().max(MAX_STRING).optional(),
  target: TargetSchema.optional(),
  state: z.enum(['visible', 'hidden', 'attached', 'detached', 'enabled']).optional(),
  url: z.string().max(MAX_STRING).optional(),
  ms: z.number().int().min(0).max(60_000).optional(),
});

export const NavigateArgsSchema = z.strictObject({
  ...actionCommon,
  url: z.string().max(MAX_URL).optional(),
  action: z.enum(['back', 'forward', 'reload']).optional(),
});

export const TabsArgsSchema = z.strictObject({
  intent: readCommon.intent,
  action: z.enum(['list', 'open', 'select', 'close']),
  url: z.string().max(MAX_URL).optional(),
  tabId: z.number().int().optional(),
});

export const HandleDialogArgsSchema = z.strictObject({
  ...actionCommon,
  accept: z.boolean(),
  promptText: z.string().max(MAX_TEXT).optional(),
});

/**
 * `upload` (files capability): files into a file input, from local paths (`DOM.setFileInputFiles`) or as bytes
 * (base64), which the probe turns into `File` objects. Exactly one source. Without a target, the input of the pending
 * file chooser.
 */
export const UploadArgsSchema = z.strictObject({
  ...actionCommon,
  target: TargetSchema.optional().describe('The file input; leave out to fill the pending file chooser'),
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(20).optional(),
  attachments: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(255),
        mimeType: z.string().max(255),
        base64: z.string().max(MAX_BASE64),
      }),
    )
    .min(1)
    .max(20)
    .optional(),
});

export const AskUserArgsSchema = z.strictObject({
  tabId: readCommon.tabId,
  message: z.string().min(1).max(2000),
  kind: z.enum(['takeover', 'input']),
  timeoutMs: z.number().int().min(1000).max(900_000).optional(),
});

export type Target = z.infer<typeof TargetSchema>;
export type RefTarget = z.infer<typeof RefTargetSchema>;
export type SemanticTarget = z.infer<typeof SemanticTargetSchema>;
export type Expectation = z.infer<typeof ExpectationSchema>;
export type Observe = z.infer<typeof ObserveSchema>;
export type SnapshotArgs = z.infer<typeof SnapshotArgsSchema>;
export type FindArgs = z.infer<typeof FindArgsSchema>;
export type ReadArgs = z.infer<typeof ReadArgsSchema>;
export type ScreenshotArgs = z.infer<typeof ScreenshotArgsSchema>;
export type ClickArgs = z.infer<typeof ClickArgsSchema>;
export type SetArgs = z.infer<typeof SetArgsSchema>;
export type FillFormArgs = z.infer<typeof FillFormArgsSchema>;
export type TypeArgs = z.infer<typeof TypeArgsSchema>;
export type PressArgs = z.infer<typeof PressArgsSchema>;
export type HoverArgs = z.infer<typeof HoverArgsSchema>;
export type ScrollArgs = z.infer<typeof ScrollArgsSchema>;
export type WaitArgs = z.infer<typeof WaitArgsSchema>;
export type NavigateArgs = z.infer<typeof NavigateArgsSchema>;
export type TabsArgs = z.infer<typeof TabsArgsSchema>;
export type HandleDialogArgs = z.infer<typeof HandleDialogArgsSchema>;
export type UploadArgs = z.infer<typeof UploadArgsSchema>;
export type AskUserArgs = z.infer<typeof AskUserArgsSchema>;

export function isRefTarget(target: Target): target is RefTarget {
  return 'ref' in target;
}

export function isSemanticTarget(target: Target): target is SemanticTarget {
  return 'role' in target;
}
