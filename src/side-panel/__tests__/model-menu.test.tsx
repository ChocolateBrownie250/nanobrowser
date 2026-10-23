// The model picker with its menu open: the names the effort pills carry for GLM on Z.ai (Low, High, Max), and that each
// name is the value the pill sends, in English and Traditional Chinese.
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelMenu } from '../ModelMenu';
import type { ModelChoice } from '../ModelMenu';
import { REASONING_EFFORTS } from '@src/llm/catalogue';
import type { ReasoningEffort } from '@src/llm/catalogue';
import { resolveProfile, wireEffort } from '@src/llm/profiles';
import type { ProviderKind } from '@src/llm/providers';
import { setLanguage, t } from '@src/ui/i18n';
import type { MessageKey } from '@src/ui/i18n';

const ZAI_URL = 'https://api.z.ai/api/anthropic/v1';

function choice(kind: ProviderKind, modelName: string, baseUrl?: string): ModelChoice {
  const profile = resolveProfile({ kind, modelName, baseUrl });
  return {
    ref: { providerId: 'p', model: modelName },
    label: `${modelName} · Provider`,
    name: modelName,
    capability: profile.reasoning,
    labels: profile.labels,
  };
}

function render(model: ModelChoice, reasoning: ReasoningEffort, open = true) {
  return renderToStaticMarkup(
    <ModelMenu
      models={[model]}
      model={model.ref}
      reasoning={reasoning}
      running={false}
      onModel={() => undefined}
      onReasoning={() => undefined}
      defaultOpen={open}
    />,
  );
}

/** The pills of the effort row: their text and whether each is the checked one. */
function pills(html: string): Array<{ text: string; checked: boolean }> {
  return [...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="(true|false)"[^>]*>([^<]*)<\/button>/g)].map(
    m => ({
      text: m[2],
      checked: m[1] === 'true',
    }),
  );
}

/** The model button's opening tag and what it holds. */
const modelButton = (html: string) => /<button[^>]*aria-haspopup="menu"[^>]*>(.*?)<\/button>/.exec(html);
const aria = (html: string) => /aria-label="([^"]*)"/.exec(modelButton(html)?.[0] ?? '')?.[1];
const buttonText = (html: string) =>
  (modelButton(html)?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

afterEach(async () => {
  await setLanguage('en');
});

describe('the picker for GLM-5.3 on Z.ai', () => {
  const glm = choice('anthropic', 'glm-5.3', ZAI_URL);

  it('names the pills Low, High and Max, with High checked for the default Medium', () => {
    expect(pills(render(glm, 'medium'))).toEqual([
      { text: 'Low', checked: false },
      { text: 'High', checked: true },
      { text: 'Max', checked: false },
    ]);
    expect(pills(render(glm, 'high')).map(p => p.text)).toEqual(['Low', 'High', 'Max']);
    expect(pills(render(glm, 'high')).find(p => p.checked)?.text).toBe('Max');
  });

  it('shows a stored None as Low, which is what is sent', () => {
    expect(pills(render(glm, 'none')).find(p => p.checked)?.text).toBe('Low');
  });

  it('puts the effort in the button and in its label', () => {
    const html = render(glm, 'high', false);
    expect(buttonText(html)).toBe('glm-5.3 · Max');
    expect(aria(html)).toBe('Model: glm-5.3 · Max');
    expect(html).not.toContain('role="menu"');
  });

  it('names each pill by the value it sends, so the names cannot drift from the wire', () => {
    const profile = resolveProfile({ kind: 'anthropic', modelName: 'glm-5.3', baseUrl: ZAI_URL });
    const shown = pills(render(glm, 'medium')).map(p => p.text);
    const sent = REASONING_EFFORTS.filter(e => e !== 'none').map(e =>
      t(`reasoning.${wireEffort(profile, e)!}` as MessageKey),
    );
    expect(shown).toEqual(sent);
  });

  it('says 最大 for Max in Traditional Chinese, in the pill, the button and the label', async () => {
    await setLanguage('zh_TW');
    const html = render(glm, 'high');
    expect(pills(html).map(p => p.text)).toEqual(['低', '高', '最大']);
    expect(pills(html).find(p => p.checked)?.text).toBe('最大');
    expect(aria(html)).toBe('模型: glm-5.3 · 最大');
    expect(buttonText(render(glm, 'high', false))).toBe('glm-5.3 · 最大');
  });
});

describe('the picker for models without the vendor’s names', () => {
  it('keeps Low, Medium and High for GLM on OpenRouter, where High still sends high', () => {
    const glm = choice('openrouter', 'z-ai/glm-5.3');
    expect(glm.labels).toBeUndefined();
    expect(pills(render(glm, 'medium')).map(p => p.text)).toEqual(['Low', 'Medium', 'High']);
  });

  it('keeps them for Claude, which also has the None pill', () => {
    const claude = choice('anthropic', 'claude-sonnet-5-5');
    expect(pills(render(claude, 'low')).map(p => p.text)).toEqual(['None', 'Low', 'Medium', 'High']);
  });

  it('shows no effort row for a model that does not reason', () => {
    expect(pills(render(choice('openai', 'gpt-4o'), 'medium'))).toEqual([]);
  });
});
