import { describe, expect, it } from 'vitest';
import type { FormFacts } from '../../probe';
import { AFFIRMATIVE, classify, enterSubmits } from '../interaction/classify';
import { keyMode } from '../interaction/keys';

const plain: FormFacts = {
  tag: 'button',
  type: 'button',
  classes: '',
  isLink: false,
  submitter: false,
  field: false,
  form: null,
  money: '',
  textEntry: false,
  searchField: false,
};
const form = (over: Partial<NonNullable<FormFacts['form']>> = {}): NonNullable<FormFacts['form']> => ({
  method: 'post',
  action: 'https://shop.test/order',
  search: false,
  fields: 2,
  blockingFields: 2,
  hasSubmitButton: true,
  defaultButton: { name: 'Save', disabled: false },
  ...over,
});
const activate = (name: string, facts: Partial<FormFacts> = {}) =>
  classify({ mode: 'activate', name, role: 'button', facts: { ...plain, ...facts } }).category;
const enter = (facts: Partial<FormFacts>) =>
  classify({
    mode: 'enter',
    name: 'Field',
    role: 'textbox',
    facts: { ...plain, tag: 'input', type: 'text', field: true, ...facts },
  }).category;

describe('sensitivity classifier', () => {
  it('classifies payment, deletion and submission vocabulary, pay first', () => {
    expect(activate('Pay now')).toBe('pay');
    expect(activate('Place order')).toBe('pay');
    expect(activate('Checkout')).toBe('pay');
    expect(activate('立即购买')).toBe('pay');
    expect(activate('结账')).toBe('pay');
    expect(activate('Top up')).toBe('pay');
    expect(activate('Delete')).toBe('delete');
    expect(activate('Cancel subscription')).toBe('delete');
    expect(activate('Remove item')).toBe('delete');
    expect(activate('Publish')).toBe('submit');
    expect(activate('Send message')).toBe('submit');
    expect(activate('Show details')).toBeNull();
    expect(activate('Cancel')).toBeNull();
  });

  it('treats a generic confirm label next to a money amount as pay', () => {
    expect(activate('Confirm', { money: '$49.00' })).toBe('pay');
    expect(activate('Confirm')).toBe('submit');
    expect(activate('OK', { money: '¥1,280' })).toBe('pay');
  });

  it('classifies by class or test ID when the name is neutral', () => {
    expect(activate('', { classes: 'btn btn-delete' })).toBe('delete');
    expect(activate('🗑', { classes: 'icon trash-button' })).toBe('delete');
    expect(activate('Edit', { classes: 'deleted-items-link' })).toBeNull();
  });

  it('counts a submit button only with a form owner, and not for a search form', () => {
    expect(activate('Continue', { submitter: true, form: form() })).toBe('submit');
    // A typeless <button> outside any form: no form owner, so not submit by type alone.
    expect(activate('Continue', { submitter: false, form: null })).toBeNull();
    expect(activate('Go', { submitter: true, form: form({ search: true }) })).toBeNull();
  });

  it('follows implicit submission for Enter in a field', () => {
    // A default button that is not disabled submits, and its name decides the category.
    expect(enter({ form: form({ defaultButton: { name: 'Place order', disabled: false } }) })).toBe('pay');
    expect(enter({ form: form({ defaultButton: { name: 'Delete account', disabled: false } }) })).toBe('delete');
    expect(enter({ form: form() })).toBe('submit');
    // A disabled default button: Enter does not submit.
    expect(enter({ form: form({ defaultButton: { name: 'Save', disabled: true } }) })).toBeNull();
    // No submit button and one blocking field: Enter submits; two blocking fields: it does not.
    expect(enter({ form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 1, fields: 1 }) })).toBe(
      'submit',
    );
    expect(enter({ form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 2 }) })).toBeNull();
    // A single-field POST form is not a search form; a search form is exempt from submit only.
    expect(
      enter({
        form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 1, fields: 1, method: 'post' }),
      }),
    ).toBe('submit');
    expect(enter({ form: form({ search: true }) })).toBeNull();
    expect(enter({ form: form({ search: true, defaultButton: { name: 'Pay now', disabled: false } }) })).toBe('pay');
    expect(enter({ form: form({ search: true, defaultButton: { name: 'Delete all', disabled: false } }) })).toBe(
      'delete',
    );
    expect(
      enter({ money: '$15.00', form: form({ search: true, defaultButton: { name: 'Confirm', disabled: false } }) }),
    ).toBe('pay');
    // The accessible name (aria-labelledby) counts as well as the probe's approximation of it.
    expect(
      enter({
        form: form({ search: true, defaultButton: { name: 'Continue', accessibleName: 'Pay now', disabled: false } }),
      }),
    ).toBe('pay');
    expect(
      enter({ form: form({ defaultButton: { name: 'Delete', accessibleName: 'Continue', disabled: false } }) }),
    ).toBe('delete');
    expect(enter({ form: null })).toBeNull();
  });

  it('exposes the implicit-submission rule', () => {
    expect(
      enterSubmits({ ...plain, form: form({ hasSubmitButton: false, defaultButton: null, blockingFields: 0 }) }),
    ).toBe(true);
    expect(enterSubmits({ ...plain, form: null })).toBe(false);
  });
});

describe('Chinese vocabulary, Simplified and Traditional', () => {
  const consent = 'https://id.example/oauth/consent';
  const onConsent = (name: string) =>
    classify({ mode: 'activate', name, role: 'button', facts: plain, url: consent }).category;

  it('classifies the Traditional forms like the Simplified ones', () => {
    for (const name of ['購買', '立即購買', '下單', '結帳', '結算', '儲值', '訂閱', '轉帳', '捐款', '付款', '支付']) {
      expect(activate(name), name).toBe('pay');
    }
    for (const name of ['刪除', '刪除帳號', '移除', '清空', '註銷', '取消訂閱']) {
      expect(activate(name), name).toBe('delete');
    }
    for (const name of [
      '提交',
      '發送',
      '發布',
      '確認',
      '保存',
      '儲存',
      '更新',
      '創建',
      '建立',
      '批准',
      '拒絕',
      '駁回',
    ]) {
      expect(activate(name), name).toBe('submit');
    }
    // The Simplified forms still work.
    expect(activate('购买')).toBe('pay');
    expect(activate('删除')).toBe('delete');
    expect(activate('发送')).toBe('submit');
    expect(activate('订阅')).toBe('pay');
    expect(activate('取消订阅')).toBe('delete');
    expect(activate('展開')).toBeNull();
    expect(activate('取消')).toBeNull();
  });

  it('grants: Traditional access vocabulary', () => {
    for (const name of ['授權', '授权', '允許訪問', '允许访问', '授予訪問']) {
      expect(activate(name), name).toBe('grant');
    }
  });

  it('a Traditional cookie refusal is not a write, either', () => {
    expect(activate('拒絕所有')).toBeNull();
    expect(activate('全部拒絕')).toBeNull();
    expect(activate('拒絕 Cookie')).toBeNull();
    expect(activate('拒絕所有', { submitter: true, form: form() })).toBe('submit');
  });

  it('a generic Chinese confirmation next to an amount is pay (\\b never holds after a Chinese character)', () => {
    for (const name of ['确认', '確認', '确定', '確定', '继续', '繼續', '下一步']) {
      expect(activate(`${name} ¥99`, { money: '¥99' }), name).toBe('pay');
      expect(activate(`${name}¥99`, { money: '¥99' }), name).toBe('pay');
      expect(activate(name, { money: '¥99' }), name).toBe('pay');
    }
    // Without an amount a confirmation is a plain submission (or nothing).
    expect(activate('确认 ¥99')).toBe('submit');
    expect(activate('確認')).toBe('submit');
    expect(activate('确定')).toBeNull();
    // English keeps its word boundary: "Confirmation" and "Okapi" are not generic labels.
    expect(activate('Confirm $49', { money: '$49' })).toBe('pay');
    expect(activate('Okapi', { money: '$49' })).toBeNull();
    expect(activate('Nextdoor', { money: '$49' })).toBeNull();
  });

  it('an affirmative Chinese label followed by more characters grants access on a consent page', () => {
    for (const name of ['允许全部', '允許全部', '允许', '允許', '同意并继续', '接受', '批准']) {
      expect(AFFIRMATIVE.test(name), name).toBe(true);
    }
    expect(onConsent('允许全部')).toBe('grant');
    expect(onConsent('允許全部')).toBe('grant');
    expect(onConsent('同意並繼續')).toBe('grant');
    expect(onConsent('Allow all')).toBe('grant');
    // Off a consent page it stays a cookie banner's label, not a grant.
    expect(activate('允许全部')).toBeNull();
    expect(AFFIRMATIVE.test('Allowance')).toBe(false);
    expect(AFFIRMATIVE.test('Yesterday')).toBe(false);
  });
});

describe('enrichments', () => {
  const field: FormFacts = { ...plain, tag: 'textarea', type: 'textarea', textEntry: true };

  it('item 3: access vocabulary is grant, and an affirmative label on a consent page', () => {
    expect(classify({ mode: 'activate', name: 'Authorize', role: 'button', facts: plain }).category).toBe('grant');
    expect(classify({ mode: 'activate', name: '授权', role: 'button', facts: plain }).category).toBe('grant');
    expect(
      classify({
        mode: 'activate',
        name: 'Allow',
        role: 'button',
        facts: plain,
        url: 'https://acct.example/oauth/consent?x',
      }).category,
    ).toBe('grant');
    // A cookie banner's "Allow" elsewhere is not.
    expect(
      classify({ mode: 'activate', name: 'Allow', role: 'button', facts: plain, url: 'https://shop.example/' })
        .category,
    ).toBe(null);
  });

  it('item 3: a consent form submit button is grant, before submit', () => {
    const facts = { ...plain, submitter: true, form: form() };
    expect(
      classify({ mode: 'activate', name: 'Continue', role: 'button', facts, url: 'https://id.example/authorize' })
        .category,
    ).toBe('grant');
  });

  it('item 6: Enter in a text field with no form sends, unless it is a search field', () => {
    expect(classify({ mode: 'enter', name: 'Message', role: 'textbox', facts: field }).category).toBe('submit');
    expect(
      classify({ mode: 'enter', name: 'Search', role: 'searchbox', facts: { ...field, searchField: true } }).category,
    ).toBe(null);
    expect(classify({ mode: 'enter', name: 'Price', role: 'slider', facts: plain }).category).toBe(null);
  });

  it('item 6: Enter in a contenteditable chat box with a neutral name is a send (mode comes from keyMode)', () => {
    const chatFacts: FormFacts = { ...plain, tag: 'div', type: '', textEntry: true };
    for (const host of [
      { tag: 'div', type: '', contentEditable: true, role: 'textbox' },
      { tag: 'div', type: '', contentEditable: false, role: 'textbox' },
      { tag: 'div', type: '', contentEditable: true, role: '' },
    ]) {
      const mode = keyMode('Enter', host);
      expect(mode).toBe('enter');
      expect(classify({ mode: mode as 'enter', name: 'Message', role: 'textbox', facts: chatFacts }).category).toBe(
        'submit',
      );
    }
  });

  it('item 7: "save" and "update" are submission vocabulary', () => {
    expect(classify({ mode: 'activate', name: 'Save changes', role: 'button', facts: plain }).category).toBe('submit');
    expect(classify({ mode: 'activate', name: 'Update profile', role: 'button', facts: plain }).category).toBe(
      'submit',
    );
    expect(classify({ mode: 'activate', name: '保存', role: 'button', facts: plain }).category).toBe('submit');
  });

  it('"create", "approve" and "reject" are submission vocabulary', () => {
    expect(activate('Create')).toBe('submit');
    expect(activate('Create issue')).toBe('submit');
    expect(activate('Approve')).toBe('submit');
    expect(activate('Reject')).toBe('submit');
    expect(activate('Reject all changes')).toBe('submit');
    expect(activate('创建')).toBe('submit');
    expect(activate('批准')).toBe('submit');
    expect(activate('驳回')).toBe('submit');
    expect(activate('Recreate')).toBeNull();
    // On a consent page, "Approve" is still a grant.
    expect(
      classify({ mode: 'activate', name: 'Approve', role: 'button', facts: plain, url: 'https://id.example/oauth' })
        .category,
    ).toBe('grant');
  });

  it("a cookie banner's refusal is not a write", () => {
    expect(activate('Reject all')).toBeNull();
    expect(activate('Reject All')).toBeNull();
    expect(activate('Reject cookies')).toBeNull();
    expect(activate('Reject non-essential cookies')).toBeNull();
    expect(activate('拒绝所有')).toBeNull();
    expect(activate('拒绝 Cookie')).toBeNull();
    // Only the word list is set aside: a refusal that submits its form still asks.
    expect(activate('Reject all', { submitter: true, form: form() })).toBe('submit');
  });

  it('Enter in a form whose default button is "Create" submits it', () => {
    expect(enter({ form: form({ defaultButton: { name: 'Create', disabled: false } }) })).toBe('submit');
  });
});
