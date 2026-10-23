// The sensitivity classifier: deterministic, from the accessible name and structural facts.
// It answers what the action will do; for forms, whether it will submit one. It follows the ideas of huashu-chrome's
// payment gate (vocabulary, and a money amount next to a generic confirmation label), written independently, and is
// deliberately kept at that scope for the first version: vocabulary, money next to a generic label, form ownership
// and HTML implicit submission, with no wider heuristics (the user's direction, 2026-10-04).
// The vocabulary covers exactly three languages: English, Simplified Chinese and Traditional Chinese (the product's UI
// languages). A label in any other language (Japanese, Korean, Spanish, French, German, Russian...) is not recognised by
// name; such a control is judged by the structural rules only: a submit button owned by a form, Enter in a form, a
// destructive class or test ID, and Enter in a text field with no form.
// The vocabulary errs toward inclusion: a false positive costs one prompt, a false negative an irreversible action.
import type { SensitiveCategory } from '../../protocol/results';
import type { FormFacts } from '../../probe';
import { quote } from '../text';

/**
 * Builds a case-insensitive matcher: English phrases match on word boundaries, Chinese phrases (Simplified and
 * Traditional) anywhere. `\b` is ASCII-only in JavaScript and never holds between two Chinese characters, so the
 * Chinese alternatives carry no boundary.
 */
function vocabulary(english: string[], chinese: string[]): RegExp {
  const words = english.map(w => w.trim().split(/\s+/).join('\\s*'));
  return new RegExp(`\\b(?:${words.join('|')})\\b|${chinese.join('|')}`, 'i');
}

export const PAY_WORDS = vocabulary(
  [
    'pay',
    'payment',
    'pay now',
    'buy',
    'buy now',
    'purchase',
    'checkout',
    'check out',
    'place order',
    'place the order',
    'order now',
    'complete order',
    'complete purchase',
    'complete booking',
    'book now',
    'subscribe',
    'donate',
    'confirm and pay',
    'transfer money',
    'top up',
  ],
  [
    // Simplified
    '付款',
    '支付',
    '购买',
    '下单',
    '结账',
    '结帐',
    '结算',
    '充值',
    // Not 取消订阅 (cancel a subscription), which is a deletion; likewise for an order, a booking or an automatic
    // renewal that is cancelled.
    '(?<!取消)订阅',
    '(?<!取消)订购',
    '(?<!取消)预订',
    '(?<!取消)下订',
    '(?<!(?:取消|关闭)(?:自动)?)续费',
    '付费',
    '买单',
    '提交订单',
    '确认订单',
    '转账',
    '转帐',
    '汇款',
    '捐款',
    '打赏',
    '赞助',
    // Traditional (the characters that differ, and the words Taiwan and Hong Kong use)
    '購買',
    '下單',
    '結帳',
    '結賬',
    '結算',
    '儲值',
    '(?<!取消)訂閱',
    '(?<!取消)訂購',
    '(?<!取消)預訂',
    '(?<!取消)下訂',
    '(?<!(?:取消|關閉)(?:自動)?)續費',
    '付費',
    '買單',
    '提交訂單',
    '確認訂單',
    '轉帳',
    '轉賬',
    '匯款',
    '打賞',
    '贊助',
  ],
);
export const DELETE_WORDS = vocabulary(
  [
    'delete',
    'remove',
    'discard',
    'deactivate',
    'destroy',
    'erase',
    'purge',
    'trash',
    'unsubscribe',
    'cancel subscription',
    'cancel my subscription',
    'cancel account',
    'cancel membership',
    'cancel order',
    'close account',
  ],
  [
    // Simplified
    '删除',
    '移除',
    '清空',
    '注销',
    '取消订阅',
    '取消订单',
    '取消预订',
    '取消会员',
    '取消续费',
    '取消订购',
    '取消下订',
    '取消自动续费',
    '关闭续费',
    '关闭自动续费',
    '退订',
    '关闭账户',
    '关闭账号',
    '销毁',
    '丢弃',
    // Traditional
    '刪除',
    '註銷',
    '取消訂閱',
    '取消訂單',
    '取消預訂',
    '取消會員',
    '取消續費',
    '取消訂購',
    '取消下訂',
    '取消自動續費',
    '關閉續費',
    '關閉自動續費',
    '退訂',
    '關閉帳戶',
    '關閉帳號',
    '銷毀',
    '丟棄',
  ],
);
export const SUBMIT_WORDS = vocabulary(
  [
    'submit',
    'send',
    'publish',
    'post',
    'confirm',
    'apply',
    'sign up',
    'register',
    'save',
    'update',
    'create',
    'approve',
    'reject',
  ],
  [
    // Simplified
    '提交',
    '发送',
    '发布',
    '确认',
    '保存',
    '更新',
    '创建',
    '批准',
    '拒绝',
    '驳回',
    '发表',
    '发出',
    '传送',
    '寄出',
    '注册',
    '申请',
    '登记',
    '存档',
    // Traditional (the characters that differ, and the words Taiwan and Hong Kong use)
    '送出',
    '發送',
    '發布',
    '發佈',
    '發表',
    '發出',
    '傳送',
    '確認',
    '儲存',
    '存檔',
    '創建',
    '建立',
    '註冊',
    '申請',
    '登記',
    '拒絕',
    '駁回',
  ],
);
/** A cookie banner's refusal ("Reject all", "Reject cookies"), which is not a write although "reject" is. */
export const COOKIE_REJECT = /cookie|^reject\s+all$|^(?:拒绝所有|全部拒绝|拒绝全部|拒絕所有|全部拒絕|拒絕全部)$/i;
/** Granting access: protected, like a payment. */
export const GRANT_WORDS = vocabulary(
  ['authorize', 'authorise', 'allow access', 'grant access', 'give access'],
  ['授权', '允许访问', '授予访问', '授權', '允許訪問', '授予訪問'],
);
/** An affirmative label, which grants access on a consent page; "Allow" alone elsewhere is a cookie banner's. */
export const AFFIRMATIVE =
  /^(?:(?:allow|continue|accept|approve|agree|yes)(?:\b|$)|允许|允許|继续|繼續|接受|同意|批准)/i;
/** The address path of a consent page. */
const CONSENT_PATH = /oauth|authori[sz]e|consent/i;

function onConsentPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return CONSENT_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * A generic confirmation label: pay when a money amount is next to it. The English words match at a word boundary. The
 * Chinese ones match as a prefix ("确认提现", "確定轉出" move money and name what they do after the generic word).
 */
export const GENERIC_CONFIRM = new RegExp(
  '^(?:(?:confirm|ok|okay|continue|next|proceed|agree|submit|yes)(?:\\b|$)|(?:确认|確認|确定|確定|继续|繼續|下一步))',
  'i',
);
/**
 * A Chinese generic word followed by a harmless continuation: 继续购物 ("continue shopping") or 确认收货 ("confirm
 * receipt") says what it does and is not a payment because a price sits nearby. Not harmless when the label itself
 * carries a price ("继续观看 ¥6", "继续阅读全文 ¥1"): that is a paywall step.
 */
const BENIGN_CONTINUATION =
  /^(?:确认|確認|确定|確定|继续|繼續|下一步)(?:购物|購物|收货|收貨|浏览|瀏覽|阅读|閱讀|观看|觀看|学习|學習|添加|编辑|編輯)/;
const DELETE_CLASSES = /(^|[\s_-])(delete|remove|destroy|trash|discard)([\s_-]|$)/i;

export interface ClassifyInput {
  /** activate: a click, or Enter/Space on a focused button or link; enter: Enter in a field or submit:true. */
  mode: 'activate' | 'enter';
  /** The accessible name read during revalidation. */
  name: string;
  role: string;
  facts: FormFacts;
  /** The address of the frame the element is in, for the consent-page rule of `grant`. */
  url?: string;
}

export interface Classification {
  category: SensitiveCategory | null;
  reason: string;
}

function byName(name: string, money: string, url?: string): Classification | null {
  if (PAY_WORDS.test(name)) return { category: 'pay', reason: `the name ${quote(name)} is payment vocabulary` };
  // Grant before submit, so a consent form's submit button is a grant.
  if (GRANT_WORDS.test(name)) return { category: 'grant', reason: `the name ${quote(name)} grants access` };
  if (AFFIRMATIVE.test(name.trim()) && onConsentPage(url)) {
    return { category: 'grant', reason: `${quote(name)} on a consent page` };
  }
  if (
    GENERIC_CONFIRM.test(name.trim()) &&
    money &&
    !(BENIGN_CONTINUATION.test(name.trim()) && !AMOUNT_IN_LABEL.test(name))
  ) {
    return { category: 'pay', reason: `${quote(name)} next to the amount ${quote(money, 40)}` };
  }
  if (DELETE_WORDS.test(name))
    return { category: 'delete', reason: `the name ${quote(name)} is destructive vocabulary` };
  return null;
}

/** A delete shortcut (Delete, Backspace or `#`) sent to something that is not a text field: best effort, see keys.ts. */
export function classifyShortcut(): Classification {
  return {
    category: 'delete',
    reason: 'Delete, Backspace or # outside a text field is a delete shortcut on many pages',
  };
}

/**
 * A label that is, as a whole, a command to pay: "Pay now", "Place order", "Checkout", "立即支付", "提交订单", with or
 * without an amount or a count next to it ("Pay now - $49", "Checkout ($49.99)", "立即付款 ¥99"). A select's options are
 * choices before they are commands, so a payment word inside a longer or plainer label ("Buy", "Pay on delivery",
 * "Subscribe weekly", "货到付款") is not one. Only a label that can mean nothing but paying is.
 */
const PAY_COMMAND = new RegExp(
  `^(?:${[
    'pay now',
    'buy now',
    'order now',
    'purchase now',
    'donate now',
    'check\\s*out(?: now)?',
    'place (?:the |your |my )?order',
    'complete (?:the |your |my )?(?:order|purchase|payment|booking)',
    'confirm (?:and|&) pay',
    'pay (?:and|&) confirm',
    'confirm (?:the |your |my )?(?:order|purchase|payment)',
    '(?:立即|马上|馬上|确认|確認|去)(?:付款|支付|购买|購買|下单|下單|结账|结帐|結帳|結賬|结算|結算|订购|訂購)',
    '(?:提交|确认|確認)(?:订单|訂單)',
  ].join('|')})[\\s\\p{P}\\p{S}]*$`,
  'iu',
);

/**
 * A money amount written in a label: a currency sign (with the letters that go before it, "NT$499", "HK$99") or "Rs."
 * before a number, or a number with a currency code or word after it.
 */
const MONEY =
  '(?<![a-z])Rs\\.?\\s?\\d[\\d.,]*|(?:(?<![a-z])[a-z]{1,3}(?=[$€£¥￥₹₩]))?[$€£¥￥₹₩]\\s?\\d[\\d.,]*(?:\\s?(?:usd|eur|gbp|jpy|cny|rmb|inr|元|円))?|\\d[\\d.,]*\\s?(?:usd|eur|gbp|jpy|cny|rmb|inr|元|円)';
/** An amount in the label itself, for the generic-confirm rule. */
const AMOUNT_IN_LABEL = new RegExp(MONEY, 'iu');
/** Everything that reads as an amount or a count: money, bare numbers and the keycap digits some pages use ("9️⃣"). */
const AMOUNT = new RegExp(`${MONEY}|\\d\\uFE0F?\\u20E3|\\d[\\d.,]*`, 'giu');

/** A label without the amounts and counts written next to it: "(2 items)", "$49", "NT$499", "49.99 USD", "99元". */
function withoutAmounts(label: string): string {
  return label
    .replace(/[(（][^)）]*[)）]/gu, ' ')
    .replace(AMOUNT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What choosing a menu option does, judged by its label alone. Destructive vocabulary ("Delete account", "Cancel
 * order", "Move to Trash") and access vocabulary are judged as for a control, because choosing such an option does what
 * it says wherever the page acts on the choice. A label that is, as a whole, a command to pay (PAY_COMMAND) is a
 * payment. Other payment vocabulary ("Buy", "Pay on delivery", "Subscribe weekly", "Pay with saved card") is an ordinary
 * choice in a dropdown most of the time, but it may carry the payment out on change: it is a write (`submit`), which
 * asks in Ask mode, and neither runs silently nor is handed over. Submission vocabulary is left out on purpose:
 * "Update" or "Save" among a select's options is more often a sort order or a setting than a submission. Null when the
 * label says nothing.
 */
export function classifyOption(label: string, url?: string): Classification | null {
  const text = label.trim();
  if (PAY_COMMAND.test(withoutAmounts(text))) {
    return { category: 'pay', reason: `the option ${quote(text)} is a payment command` };
  }
  if (GRANT_WORDS.test(text)) return { category: 'grant', reason: `the option ${quote(text)} grants access` };
  if (AFFIRMATIVE.test(text) && onConsentPage(url)) {
    return { category: 'grant', reason: `the option ${quote(text)} on a consent page` };
  }
  if (DELETE_WORDS.test(text)) {
    return { category: 'delete', reason: `the option ${quote(text)} is destructive vocabulary` };
  }
  if (PAY_WORDS.test(text)) {
    return { category: 'submit', reason: `the option ${quote(text)} is payment vocabulary, and choosing it may pay` };
  }
  return null;
}

/**
 * Whether Enter in a field submits its form owner (HTML implicit submission): the form has a default button that is
 * not disabled, or no submit button at all and at most one field that blocks implicit submission.
 */
export function enterSubmits(facts: FormFacts): boolean {
  const form = facts.form;
  if (!form) return false;
  if (form.defaultButton) return !form.defaultButton.disabled;
  return !form.hasSubmitButton && form.blockingFields <= 1;
}

export function classify(input: ClassifyInput): Classification {
  const { facts } = input;
  const name = input.name.trim();
  if (input.mode === 'enter') {
    // Enter in a text field with no form sends what it holds in chat, comment and message boxes (item 6).
    if (!facts.form && facts.textEntry && !facts.searchField) {
      return {
        category: 'submit',
        reason: 'Enter in a text field with no form (a chat or comment box sends on Enter)',
      };
    }
    if (!facts.form || !enterSubmits(facts)) return { category: null, reason: 'Enter does not submit a form here' };
    // The default button's name says what the submission does; a search form is exempt from submit only, so pay
    // and delete still need the user, as they would for a click on that button. Both its accessible name and the
    // probe's approximation are checked: either one is enough.
    const names = [facts.form.defaultButton?.accessibleName, facts.form.defaultButton?.name].filter(
      (n): n is string => !!n,
    );
    for (const button of names) {
      const named = byName(button, facts.money, input.url);
      if (named) return { ...named, reason: `Enter submits the form through ${quote(button)}: ${named.reason}` };
    }
    if (facts.form.search) return { category: null, reason: 'a search form' };
    return {
      category: 'submit',
      reason: `Enter submits the form (${facts.form.method.toUpperCase()} ${quote(facts.form.action)})`,
    };
  }
  const named = byName(name, facts.money, input.url);
  if (named) return named;
  if (DELETE_CLASSES.test(facts.classes))
    return { category: 'delete', reason: `its class or test ID (${quote(facts.classes, 80)}) is destructive` };
  if (facts.submitter && facts.form && !facts.form.search) {
    return {
      category: 'submit',
      reason: `it submits its form (${facts.form.method.toUpperCase()} ${quote(facts.form.action)})`,
    };
  }
  if (SUBMIT_WORDS.test(name) && !facts.form?.search && !COOKIE_REJECT.test(name))
    return { category: 'submit', reason: `the name ${quote(name)} is submission vocabulary` };
  return { category: null, reason: 'not submit, pay or delete' };
}
