// The probe: the only code that runs in the page. It runs in an isolated world, so the page cannot see or alter it, and
// it never computes accessible names.
//
// `probeMain` must stay self-contained: it is turned into a string with Function.prototype.toString and evaluated
// in the page, so it may not reference anything outside its own body (no imports, no module constants).

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProbeState {
  connected: boolean;
  tag: string;
  type: string;
  role: string;
  visible: boolean;
  /** Not disabled, aria-disabled or inert, including through ancestors and fieldsets. */
  enabled: boolean;
  /** An input, textarea or contenteditable that is not read-only (and not disabled). */
  editable: boolean;
  contentEditable: boolean;
  checked: boolean | 'mixed' | null;
  value: string | null;
  inShadow: boolean;
  /** For masking decisions in core. */
  autocomplete: string;
  name: string;
  id: string;
  /** The placeholder attribute, for masking decisions in core (it can name a secret field). */
  placeholder: string;
  /** A native select: whether several options can be selected. */
  multiple: boolean;
  /** The element has focus (through shadow roots). */
  focused: boolean;
}

/** Structural facts for the sensitivity classifier; the probe never decides the category. */
export interface FormFacts {
  tag: string;
  type: string;
  /** class and test IDs (data-testid, data-test, data-qa), for the delete vocabulary. */
  classes: string;
  isLink: boolean;
  /** A button with no type or type=submit, or an input of type submit or image, that has a form owner. */
  submitter: boolean;
  /** A field Enter can submit from: an input that takes text, or a select. */
  field: boolean;
  form: null | {
    /** The submitter's method and address (its formmethod and formaction, else the form's). */
    method: string;
    action: string;
    /** role=search, a type=search input, or a single-field form submitted with GET. */
    search: boolean;
    fields: number;
    /** Fields that block implicit submission in Chrome: text, search, url, tel, email, password, number. */
    blockingFields: number;
    hasSubmitButton: boolean;
    /** The button Enter in this element submits through: for a text field the form's default button (its first
     *  submit button in tree order, wherever it sits), for any other control the first one that is not disabled.
     *  `name` is the probe's approximation; the gate adds Chrome's accessible name. */
    defaultButton: null | { name: string; disabled: boolean; accessibleName?: string };
  };
  /** A money amount in the element or its parent (huashu's rule: wider containers gave false positives). */
  money: string;
  /** A place to type text: a textarea, a contenteditable element, or an input that takes text. */
  textEntry: boolean;
  /**
   * A search field: type=search, role searchbox or combobox, inside role=search or a <search> element, or a name,
   * placeholder or label that is search vocabulary.
   */
  searchField: boolean;
}

/** Where activating an element (or pressing Enter in it) would navigate (policy layer 2). */
export interface NavigationTarget {
  kind: 'link' | 'form';
  url: string;
  method: string;
  newTab: boolean;
}

export interface OptionResult {
  ok: boolean;
  error?: 'NO_SUCH_OPTION' | 'AMBIGUOUS_OPTION';
  /** Every option, for error messages; the controller decides what of it may be printed. */
  options: SelectedOption[];
  /** Labels of the options selected when the events had run (a synchronous change handler included). */
  selected: string[];
  /** The options the request matched, by index and value (their identity), with labels for display. */
  requested?: SelectedOption[];
  /** Requested values that matched more than one option, or none. */
  problem?: string;
}

/** A select option: its index and value identify it; its label is for display. */
export interface SelectedOption {
  index: number;
  value: string;
  label: string;
  /** The option's visible text, when it differs from the label (a `label` attribute): both are judged by the gate. */
  text?: string;
}

export interface HitVerdict {
  accepted: boolean;
  /** inside: the target or a node inside it; label: a label of the target, off its interactive content;
   *  nested: a separate control inside the target (a button inside a clickable card), which would take the click;
   *  ancestor: an ancestor of the target would receive the click; other: anything else. */
  kind: 'inside' | 'label' | 'nested' | 'ancestor' | 'other';
}

export interface GuardReport {
  /** none: no press reached this document; passed: the press hit the target; cancelled: it did not, and the
   *  sequence was cancelled by the guard (target and bubbling handlers did not run; a page capture listener on the
   *  window that was registered earlier may have seen the event). */
  verdict: 'none' | 'passed' | 'cancelled';
  /** What was at the press point, when the guard cancelled. */
  hit: string;
  /** Trusted event types seen while armed, in order (the first 100). */
  seen: string[];
  /** Text mode: keydown and beforeinput events accepted at the target, so the controller can tell that each key or
   *  insertion of a sequence arrived there. Pointer mode: press events (pointerdown, mousedown) accepted. */
  accepted?: number;
  /** Text mode: keyups that arrived elsewhere after their key was accepted (the key's own default action, such as
   *  Tab or a submission, moved focus); they are withheld from the page, and are not a failure. */
  strayKeyups?: number;
}

/** The text guard between two keys of a sequence. */
export interface GuardStep extends GuardReport {
  /** The guard is still installed (it lapses 4 s after the last step). */
  armed: boolean;
  /** Focus is on the target now. */
  focusOk: boolean;
  /** What has focus now. */
  focus: string;
}

export interface ScrollInfo {
  top: number;
  left: number;
  height: number;
  width: number;
  clientHeight: number;
  clientWidth: number;
}

/** Page-level facts for effect evidence version 2. */
export interface PageFacts {
  /** Text of alert and live regions. */
  alerts: string[];
  /** Validation messages of invalid fields. */
  invalid: string[];
  /** Open dialogs and modal layers, described. */
  layers: string[];
}

export interface ProbeApi {
  version: number;
  state(el: Element): ProbeState;
  textDigest(el: Element, max?: number): string;
  nameSources(el: Element): string;
  mutations(): number;
  hitAccepts(target: Element, hit: Node): HitVerdict;
  describe(el: Node): string;
  armGuard(target: Element, mode: 'pointer' | 'text', lifetimeMs?: number, unfocused?: boolean): void;
  armAncestorGuard(lifetimeMs?: number): void;
  armAwayGuard(lifetimeMs?: number): void;
  armDocumentGuard(lifetimeMs?: number): void;
  armBlockGuard(kind: 'pointer' | 'text', lifetimeMs?: number): void;
  stepGuard(lifetimeMs?: number): GuardStep;
  renewGuard(lifetimeMs?: number): boolean;
  readGuard(): GuardReport;
  disarm(): void;
  scrollInfo(el: Element | null): ScrollInfo;
  viewport(): { width: number; height: number };
  matchOptions(el: Element, values: string[]): OptionResult;
  selectOption(el: Element, values: string[]): OptionResult;
  selectedOptions(el: Element): SelectedOption[];
  selectContents(el: Element): boolean;
  watchBlock(el: Element): string;
  blockMutations(): number;
  hasText(text: string): boolean;
  navigationTarget(el: Element, mode: 'activate' | 'enter'): NavigationTarget | null;
  focused(): Element | null;
  activeIn(root: Node): Element | null;
  documentFocused(): boolean;
  formFacts(el: Element): FormFacts;
  defaultButtonOf(el: Element): Element | null;
  approximateName(el: Element): string;
  labelFor(input: Element): Element | null;
  labelPoint(input: Element): { fx: number; fy: number } | null;
  pageFacts(): PageFacts;
  contextOf(container: Element, target: Element): { inside: boolean; text: string; shown: string };
  setNativeValue(el: Element, value: string): string;
  fileInputFacts(el: Element): FileInputFacts;
  fileChunk(el: Element, key: string, chunk: string): number;
  dropFiles(el: Element, keys: string[]): number;
  setFiles(el: Element, specs: Array<{ key: string; name: string; mimeType: string }>): FileInfo[];
  fileList(el: Element): FileInfo[];
}

/** A file input, for `upload`. */
export interface FileInputFacts {
  isFileInput: boolean;
  multiple: boolean;
  accept: string;
  disabled: boolean;
}

export interface FileInfo {
  name: string;
  size: number;
  type: string;
}

export function probeMain(): void {
  const g = globalThis as any;
  if (g.__nbProbe) return;

  let mutationCount = 0;
  /** File bytes for `upload`, as base64 chunks by key, until the files are built. */
  const fileChunks = new Map<string, string[]>();
  try {
    new MutationObserver(records => {
      mutationCount += records.length;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    // A document without a root yet; counting starts with the next document.
  }

  // A form's named controls shadow the form's own properties and methods (`form.closest`, `form.parentNode`,
  // `form.id`, `form.getAttribute` and the rest are then the control of that name), and LegacyOverrideBuiltIns lets
  // them win over the prototype. Every member read on a node that may be a form (an ancestor, a hit, a container, a
  // block) goes through these helpers, which take the member from the prototype of this world, which the page cannot
  // change. Calling `form.closest(...)` directly throws, or, for `parentNode`, loops for ever.
  const nodeProp = (n: Node, name: 'parentNode' | 'nodeType' | 'nodeName' | 'isConnected' | 'parentElement'): any =>
    Object.getOwnPropertyDescriptor(Node.prototype, name)!.get!.call(n);
  const elemProp = (e: Element, name: 'tagName' | 'id' | 'className'): any =>
    Object.getOwnPropertyDescriptor(Element.prototype, name)!.get!.call(e);
  const htmlProp = (e: Element, name: 'inert' | 'innerText' | 'isContentEditable'): any =>
    e instanceof HTMLElement ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!.get!.call(e) : undefined;
  const elemCall = (
    e: Element,
    name: 'getAttribute' | 'hasAttribute' | 'closest' | 'matches' | 'getClientRects' | 'checkVisibility',
    ...args: any[]
  ): any => (Element.prototype as any)[name].apply(e, args);
  const rootOf = (n: Node): Node => Node.prototype.getRootNode.call(n);
  const attrOf = (e: Element, name: string): string | null => elemCall(e, 'getAttribute', name);

  const disabledByAncestor = (el: Element): boolean => {
    for (let node: Element | null = el; node;) {
      if (htmlProp(node, 'inert')) return true;
      if (attrOf(node, 'aria-disabled') === 'true') return true;
      // A disabled fieldset disables its controls, except those in its first legend.
      if (elemProp(node, 'tagName') === 'FIELDSET' && node !== el) {
        if ((node as HTMLFieldSetElement).disabled) {
          const legend = node.querySelector(':scope > legend');
          if (!legend || !legend.contains(el)) return true;
        }
      } else if ((node as any).disabled === true && 'disabled' in node) return true;
      const parent: Node | null = nodeProp(node, 'parentNode');
      node = parent instanceof ShadowRoot ? parent.host : (parent as Element | null);
      if (node && nodeProp(node, 'nodeType') !== 1) node = null;
    }
    return false;
  };

  /** Parent in the composed tree: a shadow root's host, otherwise the parent node. */
  const composedParent = (n: Node): Node | null => {
    const p: Node | null = nodeProp(n, 'parentNode');
    return p instanceof ShadowRoot ? p.host : p;
  };
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';
  /**
   * A control of its own inside a target: native controls, links and the widget roles that activate. Content of an
   * editing host is text, not a control (Chrome does not follow a link there), and controls inside a shadow tree are
   * parts of their host.
   */
  const NESTED_CONTROL =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, iframe, frame, object, embed, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option]';
  /**
   * A form's own property or attribute. A control named `action`, `method`, `target` or `elements` shadows the
   * property of that name on its form (`form.action` is then the control), so they are read through the prototype.
   */
  const formProp = <K extends 'action' | 'method' | 'target' | 'elements'>(form: HTMLFormElement, name: K) =>
    Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name)!.get!.call(form) as HTMLFormElement[K];
  const formAttr = (form: HTMLFormElement, name: string) => attrOf(form, name);
  /** Fields that block implicit submission in Chrome when a form has no submit button (dates and times do not). */
  const BLOCKING = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
  const isTextField = (e: Element) =>
    elemProp(e, 'tagName') === 'INPUT' && BLOCKING.includes((e as HTMLInputElement).type || 'text');
  const isSubmitterEl = (e: Element) =>
    (elemProp(e, 'tagName') === 'BUTTON' && ((e as HTMLButtonElement).type || 'submit') === 'submit') ||
    (elemProp(e, 'tagName') === 'INPUT' && ['submit', 'image'].includes((e as HTMLInputElement).type));
  /**
   * A form's submit buttons in tree order. `form.elements` leaves out image buttons, which are submit buttons too
   * (and can be the default button), so they are added from the form's tree.
   */
  const submittersOf = (owner: HTMLFormElement): Element[] => {
    const root = rootOf(owner) as Document | ShadowRoot;
    const images = [...root.querySelectorAll('input[type=image]')].filter(i => (i as HTMLInputElement).form === owner);
    const all = [...new Set([...(formProp(owner, 'elements') as unknown as Element[]), ...images])].filter(
      isSubmitterEl,
    );
    return all.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  };

  /**
   * The button Enter in `el` submits its form through. In a text field it is the form's default button, its first
   * submit button, and a disabled one means no submission. In any other control (a checkbox, a radio, a select, a
   * date or range field) Chrome clicks the first submit button that is not disabled.
   */
  const enterButtonOf = (el: Element, owner: HTMLFormElement): Element | undefined => {
    const all = submittersOf(owner);
    return isTextField(el) ? all[0] : all.find(b => !b.matches(':disabled'));
  };

  /**
   * Elements whose content is never quoted in a message: a select's or a listbox's options and a textarea's text can be
   * secrets.
   */
  const UNQUOTED = new Set(['SELECT', 'TEXTAREA', 'DATALIST', 'OPTION', 'OPTGROUP', 'SCRIPT', 'STYLE', 'TEMPLATE']);

  /**
   * An element's rendered text for messages and evidence, whitespace collapsed, without the content of selects,
   * textareas and options, as the layout's display text. Stops once it has more than `max` characters.
   */
  const unquoted = (el: Element) => UNQUOTED.has(elemProp(el, 'tagName')) || attrOf(el, 'role') === 'option';
  const shownText = (el: Element, max: number): string => {
    if (unquoted(el)) return '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        nodeProp(n, 'nodeType') !== Node.ELEMENT_NODE
          ? NodeFilter.FILTER_ACCEPT
          : unquoted(n as Element) || elemCall(n as Element, 'checkVisibility') === false
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP,
    });
    let out = '';
    for (let n = walker.nextNode(); n && out.length <= max * 2; n = walker.nextNode()) out += ` ${n.nodeValue ?? ''}`;
    out = out.replace(/\s+/g, ' ').trim();
    return out.length > max ? `${out.slice(0, max - 1)}…` : out;
  };

  /** A control that holds a value: a text-like input, a textarea or a select (a button's value is its caption). */
  const holdsValue = (e: Element) =>
    elemProp(e, 'tagName') === 'TEXTAREA' ||
    elemProp(e, 'tagName') === 'SELECT' ||
    (elemProp(e, 'tagName') === 'INPUT' &&
      !['checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes((e as HTMLInputElement).type));

  /**
   * An approximation of an element's name, for the classifier only: never compared with Chrome's. A control that holds
   * a value is named by its labels, never by what it holds.
   */
  const nameOf = (e: Element) =>
    (
      attrOf(e, 'aria-label') ||
      (holdsValue(e)
        ? [...((e as HTMLInputElement).labels ?? [])].map(l => shownText(l, 100)).join(' ')
        : htmlProp(e, 'innerText') || (e as HTMLInputElement).value) ||
      attrOf(e, 'alt') ||
      attrOf(e, 'title') ||
      ''
    ).trim();

  const POINTER_EVENTS = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
    'auxclick',
    'dblclick',
    'contextmenu',
  ];
  const PRESSES = ['pointerdown', 'mousedown'];
  const TEXT_EVENTS = ['keydown', 'keypress', 'beforeinput', 'input', 'keyup'];
  let guard: {
    report: GuardReport;
    remove: () => void;
    renew: (lifetimeMs: number) => void;
    /** For the text guard: the element keys must go to, and its chain of shadow roots. */
    text?: { target: Element; roots: ShadowRoot[]; accepts: (hit: Element | null) => boolean };
  } | null = null;
  /** The report of the last guard armed in this world, kept after it is removed so it can still be read. */
  let lastReport: GuardReport = { verdict: 'none', hit: '', seen: [] };

  /** Shadow roots from the document down to the target's own root, so closed roots can be entered. */
  const rootsOf = (el: Element): ShadowRoot[] => {
    const roots: ShadowRoot[] = [];
    for (let root = rootOf(el); root instanceof ShadowRoot; root = rootOf(root.host)) roots.unshift(root);
    return roots;
  };
  /** The element at a point, descending through the target's chain of shadow hosts (closed ones included). */
  const deepElementFromPoint = (x: number, y: number, roots: ShadowRoot[]): Element | null => {
    let el = document.elementFromPoint(x, y);
    for (const root of roots) {
      if (!el || el !== root.host) break;
      el = root.elementFromPoint(x, y) ?? el;
    }
    return el;
  };
  /** The focused element, through the target's chain of shadow roots. */
  const deepActiveElement = (roots: ShadowRoot[]): Element | null => {
    let el = document.activeElement;
    for (const root of roots) {
      if (!el || el !== root.host) break;
      el = root.activeElement ?? el;
    }
    return el;
  };

  const install = (
    types: string[],
    handler: (e: Event) => void,
    lifetimeMs: number,
    report: GuardReport,
    text?: { target: Element; roots: ShadowRoot[]; accepts: (hit: Element | null) => boolean },
  ) => {
    for (const type of types) window.addEventListener(type, handler, true);
    const remove = () => {
      for (const type of types) window.removeEventListener(type, handler, true);
      clearTimeout(timer);
      if (guard?.remove === remove) guard = null;
    };
    // A guard never outlives its action, even if the controller cannot disarm it (a dialog blocks the page). A key
    // sequence renews it before every key, so it lasts as long as the sequence does.
    let timer = setTimeout(remove, lifetimeMs);
    const renew = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(remove, ms);
    };
    guard = { report, remove, renew, text };
    lastReport = report;
  };
  const note = (report: GuardReport, type: string) => {
    if (report.seen.length < 100) report.seen.push(type);
  };

  /** The options a request matches in a select, by value, then label, then normalized text, with the elements. */
  const matchIn = (
    select: HTMLSelectElement,
    values: string[],
  ): { result: OptionResult; picked: HTMLOptionElement[] } => {
    const options = [...select.options];
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const listing = options.map(o => ({ index: o.index, value: o.value, label: o.label }));
    const fail = (error: 'NO_SUCH_OPTION' | 'AMBIGUOUS_OPTION', problem: string) => ({
      result: { ok: false, error, options: listing, selected: [], problem },
      picked: [] as HTMLOptionElement[],
    });
    const picked: HTMLOptionElement[] = [];
    for (const value of values) {
      let matches = options.filter(o => o.value === value);
      if (!matches.length) matches = options.filter(o => o.label === value);
      if (!matches.length) matches = options.filter(o => norm(o.text) === norm(value));
      if (!matches.length) return fail('NO_SUCH_OPTION', value);
      if (matches.length > 1) return fail('AMBIGUOUS_OPTION', value);
      picked.push(matches[0]);
    }
    if (!select.multiple && picked.length > 1) return fail('AMBIGUOUS_OPTION', values.join(', '));
    // What was asked for is read before the events: a change handler may rewrite the option itself.
    const requested = picked.map(o => ({
      index: o.index,
      value: o.value,
      label: o.label,
      ...(o.text !== o.label ? { text: o.text } : {}),
    }));
    return { result: { ok: true, options: listing, selected: [], requested }, picked };
  };

  let blockCount = 0;
  let blockObserver: MutationObserver | null = null;
  const BLOCKS =
    'form, dialog, [role=dialog], [role=alertdialog], [role=menu], [role=listbox], article, section, li, tr, table, main, nav';

  const api = {
    version: 1,

    state(el: Element) {
      const tag = (elemProp(el, 'tagName') as string).toLowerCase();
      const input = el as HTMLInputElement;
      const type = tag === 'input' ? (input.type || 'text').toLowerCase() : '';
      const textInput =
        tag === 'textarea' ||
        (tag === 'input' &&
          !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color'].includes(
            type,
          ));
      const contentEditable = htmlProp(el, 'isContentEditable') === true;
      const enabled = !disabledByAncestor(el);
      const readOnly = textInput && (input.readOnly || attrOf(el, 'aria-readonly') === 'true');
      const editable = enabled && ((textInput && !readOnly) || contentEditable);
      let checked: boolean | 'mixed' | null = null;
      if (tag === 'input' && (type === 'checkbox' || type === 'radio'))
        checked = input.indeterminate ? 'mixed' : input.checked;
      else if (elemCall(el, 'hasAttribute', 'aria-checked')) {
        const a = attrOf(el, 'aria-checked');
        checked = a === 'mixed' ? 'mixed' : a === 'true';
      }
      let value: string | null = null;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') value = (el as HTMLInputElement).value;
      else if (contentEditable) value = htmlProp(el, 'innerText');
      // visibility: hidden counts as not visible; opacity 0 does not (Playwright's rule).
      const visible =
        typeof Element.prototype.checkVisibility === 'function'
          ? elemCall(el, 'checkVisibility', { visibilityProperty: true, checkVisibilityCSS: true })
          : true;
      return {
        connected: nodeProp(el, 'isConnected'),
        tag,
        type,
        role: attrOf(el, 'role') ?? '',
        visible,
        enabled,
        editable,
        contentEditable,
        checked,
        value,
        inShadow: rootOf(el) instanceof ShadowRoot,
        autocomplete: (attrOf(el, 'autocomplete') ?? '').toLowerCase(),
        name: attrOf(el, 'name') ?? '',
        id: elemProp(el, 'id'),
        placeholder: attrOf(el, 'placeholder') ?? '',
        multiple: tag === 'select' && (el as HTMLSelectElement).multiple,
        focused: (() => {
          let a: Element | null = document.activeElement;
          while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
          // Closed roots hide their active element from shadowRoot; compare through the target's own root too.
          const own = rootOf(el) as Document | ShadowRoot;
          return a === el || own.activeElement === el;
        })(),
      };
    },

    /**
     * A native select: each requested value matches an option by value, then by label, then by normalized text. None is
     * NO_SUCH_OPTION, several is AMBIGUOUS_OPTION; both list the options. Nothing is changed: the controller judges the
     * matched options (`requested`, with their labels and visible text) before anything is selected.
     */
    matchOptions(el: Element, values: string[]): OptionResult {
      return matchIn(el as HTMLSelectElement, values).result;
    },

    /**
     * Matches the options as `matchOptions` does; none or several is the same error and changes nothing. Otherwise the
     * options are selected and input and change are dispatched.
     */
    selectOption(el: Element, values: string[]): OptionResult {
      const select = el as HTMLSelectElement;
      const { result, picked } = matchIn(select, values);
      if (!result.ok) return result;
      for (const o of select.options) o.selected = picked.includes(o);
      select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ...result, selected: [...select.selectedOptions].map(o => o.label) };
    },

    /** Whether the element is a file input, and what it takes. */
    fileInputFacts(el: Element) {
      const input = el as HTMLInputElement;
      const isFileInput = el instanceof HTMLInputElement && input.type === 'file';
      return {
        isFileInput,
        multiple: isFileInput && input.multiple,
        accept: isFileInput ? input.accept : '',
        disabled: isFileInput && input.disabled,
      };
    },

    /** Holds one base64 chunk of a file: a large file arrives in several calls. */
    fileChunk(_el: Element, key: string, chunk: string) {
      const chunks = fileChunks.get(key) ?? [];
      chunks.push(chunk);
      fileChunks.set(key, chunks);
      return chunks.reduce((n, c) => n + c.length, 0);
    },

    /** Forgets the chunks held under these keys (a call that failed before its files were built); how many were held. */
    dropFiles(_el: Element, keys: string[]) {
      let held = 0;
      for (const key of keys) if (fileChunks.delete(key)) held++;
      return held;
    },

    /**
     * Builds the files from their chunks, puts them in the input through a DataTransfer and dispatches input and
     * change, as a user's choice would. Returns what the input then holds. The chunks of these keys are gone when it
     * returns, whether the files could be built or not.
     */
    setFiles(el: Element, specs: Array<{ key: string; name: string; mimeType: string }>) {
      const input = el as HTMLInputElement;
      try {
        const transfer = new DataTransfer();
        for (const spec of specs) {
          const binary = atob((fileChunks.get(spec.key) ?? []).join(''));
          fileChunks.delete(spec.key);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          transfer.items.add(new File([bytes], spec.name, { type: spec.mimeType }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return [...(input.files ?? [])].map(f => ({ name: f.name, size: f.size, type: f.type }));
      } finally {
        for (const spec of specs) fileChunks.delete(spec.key);
      }
    },

    /** The files a file input holds, for the read-back. */
    fileList(el: Element) {
      return [...((el as HTMLInputElement).files ?? [])].map(f => ({ name: f.name, size: f.size, type: f.type }));
    },

    /** A select's selected options, by index and value, for the read-back after settle. */
    selectedOptions(el: Element) {
      return [...((el as HTMLSelectElement).selectedOptions ?? [])].map(o => ({
        index: o.index,
        value: o.value,
        label: o.label,
      }));
    },

    /** Counts mutations inside the target's enclosing block (evidence version 1). */
    watchBlock(el: Element) {
      blockObserver?.disconnect();
      blockCount = 0;
      let block: Element | null = elemCall(el, 'closest', BLOCKS);
      if (!block) {
        const root = rootOf(el);
        block = root instanceof ShadowRoot ? root.host : document.body;
      }
      blockObserver = new MutationObserver(records => {
        blockCount += records.length;
      });
      blockObserver.observe(block ?? document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      return api.describe(block ?? document.documentElement);
    },

    blockMutations() {
      return blockCount;
    },

    /**
     * Where the element would navigate: the href of the link it is or sits inside (javascript: links do not
     * navigate), the formaction of a submit button with a form owner, or, for Enter in a field, its form's action.
     */
    navigationTarget(el: Element, mode: 'activate' | 'enter') {
      // A cap on the climb, so that a tree that never ends cannot hold the renderer.
      let climbed = 0;
      for (let n: Node | null = el; n && climbed < 10000; n = composedParent(n), climbed++) {
        if (nodeProp(n, 'nodeType') !== 1) continue;
        const e = n as HTMLAnchorElement;
        const eTag = elemProp(e, 'tagName');
        if ((eTag === 'A' || eTag === 'AREA') && elemCall(e, 'hasAttribute', 'href')) {
          const url = e.href;
          if (url.toLowerCase().startsWith('javascript:')) return null;
          return { kind: 'link' as const, url, method: 'GET', newTab: !!e.target && e.target !== '_self' };
        }
      }
      const control = el as HTMLButtonElement;
      const form = (control as any).form as HTMLFormElement | null | undefined;
      if (!form) return null;
      const submitter = isSubmitterEl(el);
      if (mode === 'activate' && !submitter) return null;
      // Enter in a field submits through the default button, whose formaction, formmethod and formtarget apply.
      const via = (submitter ? el : mode === 'enter' ? enterButtonOf(el, form) : undefined) as
        HTMLButtonElement | undefined;
      // formAction reflects the document URL when the attribute is absent, so read it only when it is set.
      const url = via?.hasAttribute('formaction') ? via.formAction : formProp(form, 'action');
      const method = (via?.getAttribute('formmethod') || formProp(form, 'method') || 'get').toUpperCase();
      const target = via?.getAttribute('formtarget') || formProp(form, 'target');
      return { kind: 'form' as const, url, method, newTab: !!target && target !== '_self' };
    },

    /** The default button of the element's form owner (its first submit button in tree order), for its AX name. */
    defaultButtonOf(el: Element) {
      const owner = (el as any).form as HTMLFormElement | null | undefined;
      return owner ? (enterButtonOf(el, owner) ?? null) : null;
    },

    /**
     * The name the classifier falls back on when Chrome gives the element none because it is left out of the
     * accessibility tree (aria-hidden): hiding a control from accessibility does not hide its name from the gate.
     */
    approximateName(el: Element) {
      return nameOf(el);
    },

    /** Facts the confirmation gate's classifier needs about the element and its form owner. */
    formFacts(el: Element) {
      const tag = (elemProp(el, 'tagName') as string).toLowerCase();
      const type = ((el as HTMLInputElement).type ?? '').toLowerCase();
      const testIds = ['data-testid', 'data-test', 'data-qa', 'data-test-id'].map(a => attrOf(el, a) ?? '').join(' ');
      const className = elemProp(el, 'className');
      const classes = `${typeof className === 'string' ? className : ''} ${testIds} ${elemProp(el, 'id')}`.trim();
      const DATES = ['date', 'month', 'week', 'time', 'datetime-local'];
      const owner = (el as any).form as HTMLFormElement | null | undefined;
      const field = (tag === 'input' && [...BLOCKING, ...DATES].includes(type || 'text')) || tag === 'select';
      let form: FormFacts['form'] = null;
      if (owner) {
        const elements = [...formProp(owner, 'elements')] as Element[];
        const fieldEls = elements.filter(
          e =>
            ['INPUT', 'SELECT', 'TEXTAREA'].includes(elemProp(e, 'tagName')) &&
            !['hidden', 'submit', 'image', 'button', 'reset'].includes((e as HTMLInputElement).type),
        );
        const blocking = elements.filter(isTextField);
        const submitters = submittersOf(owner);
        const first = enterButtonOf(el, owner) as HTMLButtonElement | HTMLInputElement | undefined;
        // The submission's method and address are the submitter's: the element itself when it is a submit button,
        // otherwise the default button, through which Enter submits. Its formmethod and formaction override the
        // form's (a "Continue" button with formmethod="post" in a GET form posts).
        const via = (isSubmitterEl(el) ? el : first) as HTMLButtonElement | HTMLInputElement | undefined;
        const method = (via?.getAttribute('formmethod') || formAttr(owner, 'method') || 'get').toLowerCase();
        const action = via?.hasAttribute('formaction') ? via.formAction : formProp(owner, 'action');
        const search =
          formAttr(owner, 'role') === 'search' ||
          !!elemCall(owner, 'closest', '[role=search], search') ||
          elements.some(e => elemProp(e, 'tagName') === 'INPUT' && (e as HTMLInputElement).type === 'search') ||
          // A single-field GET form is a search form, unless its one field is a textarea (a message, not a query).
          (method === 'get' && fieldEls.length === 1 && elemProp(fieldEls[0], 'tagName') !== 'TEXTAREA');
        form = {
          method,
          action,
          search,
          fields: fieldEls.length,
          blockingFields: blocking.length,
          hasSubmitButton: submitters.length > 0,
          defaultButton: first ? { name: nameOf(first), disabled: first.matches(':disabled') } : null,
        };
      }
      // A money amount: a number with a currency sign before it or a currency code or word after it.
      const findMoney = (text: string): string => {
        const signs = '$€£¥￥₹₩';
        const codes = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RMB', '元', '円'];
        const number = '\\d[\\d.,]*';
        const before = new RegExp(`[${signs}]\\s?${number}`);
        const after = new RegExp(`${number}\\s?(?:${codes.join('|')})`, 'i');
        return (before.exec(text) ?? after.exec(text))?.[0] ?? '';
      };
      let money = '';
      // Only the element and its parent: a wider container picks up amounts that belong to something else.
      for (const box of [el, nodeProp(el, 'parentElement') as Element | null]) {
        if (!money && box) money = findMoney((htmlProp(box, 'innerText') ?? '').trim());
      }
      const role = (attrOf(el, 'role') ?? '').trim().toLowerCase();
      // A place to type: a text field, an editing region (a control inside one inherits that and is not a place to
      // type), or an element that says it is a text box or search box.
      const control =
        ['button', 'a', 'area', 'summary', 'select'].includes(tag) ||
        [
          'button',
          'link',
          'checkbox',
          'radio',
          'switch',
          'menuitem',
          'menuitemcheckbox',
          'menuitemradio',
          'tab',
          'option',
          'treeitem',
        ].includes(role);
      const textEntry =
        tag === 'textarea' ||
        (tag === 'input' && [...BLOCKING, ''].includes(type) && type !== 'password') ||
        (!control && (htmlProp(el, 'isContentEditable') === true || role === 'textbox' || role === 'searchbox'));
      const words = [attrOf(el, 'name'), attrOf(el, 'placeholder'), attrOf(el, 'aria-label'), elemProp(el, 'id')]
        .filter(Boolean)
        .join(' ');
      const searchField =
        type === 'search' ||
        role === 'searchbox' ||
        role === 'combobox' ||
        !!elemCall(el, 'closest', '[role=search], search') ||
        /\b(search|query|find|lookup)\b|^q$|搜索|搜尋|搜寻|查找|尋找|寻找|查詢|查询|検索/i.test(words);
      return {
        tag,
        type,
        classes,
        textEntry,
        searchField,
        isLink: !!elemCall(el, 'closest', 'a[href], area[href]'),
        submitter: isSubmitterEl(el) && !!owner,
        field,
        form,
        money,
      };
    },

    /** The first rendered label of a checkbox or radio (a wrapping label, or one whose for names it). */
    labelFor(input: Element) {
      const labels = [...((input as HTMLInputElement).labels ?? [])];
      return labels.find(l => l.getClientRects().length > 0 && l.getBoundingClientRect().width > 0) ?? null;
    },

    /**
     * A point in the label, as fractions of its box, where a click activates the input: the hit rule must accept
     * it, so it is never on a link, button or other control inside the label.
     */
    labelPoint(input: Element) {
      const label = api.labelFor(input);
      if (!label) return null;
      const r = label.getBoundingClientRect();
      const roots = rootsOf(label);
      for (const fy of [0.5, 0.3, 0.7]) {
        for (const fx of [0.5, 0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9, 0.05, 0.95]) {
          const hit = deepElementFromPoint(r.left + fx * r.width, r.top + fy * r.height, roots);
          if (hit && api.hitAccepts(input, hit).accepted) return { fx, fy };
        }
      }
      return null;
    },

    /** Alert and live-region text, validation messages and open dialogs or modal layers (evidence version 2). */
    pageFacts() {
      const text = (el: Element) => shownText(el, 120);
      const visible = (el: Element) => elemCall(el, 'getClientRects').length > 0;
      const alerts = [
        ...document.querySelectorAll('[role=alert], [role=status], [aria-live=assertive], [aria-live=polite], output'),
      ]
        .filter(visible)
        .map(text)
        .filter(Boolean);
      const invalid = [...document.querySelectorAll(':invalid')]
        .filter(
          el =>
            'validationMessage' in el &&
            (el as HTMLInputElement).validationMessage &&
            elemProp(el, 'tagName') !== 'FORM',
        )
        .map(el => (el as HTMLInputElement).validationMessage);
      const layers = [
        ...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]'),
      ]
        .filter(visible)
        .map(
          el =>
            `${attrOf(el, 'role') ?? (elemProp(el, 'tagName') as string).toLowerCase()} "${attrOf(el, 'aria-label') ?? shownText(el, 60)}"`,
        );
      return { alerts, invalid, layers };
    },

    /**
     * The record context check: is the target still inside the container, and what is the container's text: its digest,
     * compared and never printed, and the text a message may quote (`shownText`).
     */
    contextOf(container: Element, target: Element) {
      let inside = false;
      for (let n: Node | null = target; n; n = composedParent(n)) if (n === container) inside = true;
      return { inside, text: api.textDigest(container, 2000), shown: shownText(container, 80) };
    },

    /** The focused element of this document, through open and closed shadow roots it can reach. */
    focused() {
      let a: Element | null = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a;
    },

    /** This document has focus and no element in it does (keys go to the body). */
    documentFocused() {
      const active = document.activeElement;
      return document.hasFocus() && (!active || active === document.body || active === document.documentElement);
    },

    /** The focused element inside a shadow root, closed ones included (the controller resolves the root). */
    activeIn(root: Node) {
      return (root as ShadowRoot).activeElement ?? null;
    },

    /** Whether the page's visible text contains `text` (whitespace collapsed). */
    hasText(text: string) {
      const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
      return norm(document.body?.innerText ?? '').includes(norm(text));
    },

    /** Selects the whole content of a focused field or editor, so the next insertion replaces it. */
    selectContents(el: Element) {
      const tag = elemProp(el, 'tagName');
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        try {
          (el as HTMLInputElement).select();
          return true;
        } catch {
          return false;
        }
      }
      const selection = (rootOf(el) as Document).getSelection?.() ?? document.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    },

    /** Date, time, colour and range inputs: the native prototype value setter, then input and change. */
    setNativeValue(el: Element, value: string) {
      const proto = Object.getPrototypeOf(el);
      const setter =
        Object.getOwnPropertyDescriptor(proto, 'value')?.set ??
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return (el as HTMLInputElement).value;
    },

    /**
     * The text digest: descendant text nodes in tree order, excluding shadow trees and frame content, whitespace
     * collapsed, first `max` characters (80 by default).
     */
    textDigest(el: Element, max = 80) {
      let out = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      // Whitespace is collapsed as text is added, and reading stops once more than `max` characters are held: the
      // same steps as the capture's digest (`digestOf` in layout.ts), so indentation cannot make the two differ.
      for (let n = walker.nextNode(); n && out.length <= max; n = walker.nextNode())
        out = (out + (n.nodeValue ?? '')).replace(/\s+/g, ' ').trimStart();
      return out.trim().slice(0, max);
    },

    /**
     * What a layout ref's name can come from besides its text: its `aria-label`, `aria-labelledby` and `title`
     * attributes as written, and the text digests of a field's labels, sorted. One definition, shared with capture
     * (`nameSources` in layout.ts); fields separated by U+001F.
     */
    nameSources(el: Element) {
      const attrs = ['aria-label', 'aria-labelledby', 'title'].map(a => attrOf(el, a) ?? '');
      const labelled = ['INPUT', 'SELECT', 'TEXTAREA'].includes(elemProp(el, 'tagName'))
        ? [...((el as HTMLInputElement).labels ?? [])].map(l => api.textDigest(l)).sort()
        : [];
      return [...attrs, ...labelled].join('\u001f');
    },

    mutations() {
      return mutationCount;
    },

    /** The hit rule: whether a hit-test result counts as a hit on the target. */
    hitAccepts(target: Element, hit: Node) {
      // A hit inside the target is accepted unless it is on a separate control inside it: that control would take
      // the click, and nobody classified it.
      let nested: Element | null = null;
      for (let n: Node | null = hit; n; n = composedParent(n)) {
        if (n === target) {
          return nested ? { accepted: false, kind: 'nested' as const } : { accepted: true, kind: 'inside' as const };
        }
        if (nodeProp(n, 'nodeType') === 1) {
          const el = n as Element;
          if (!nested && elemCall(el, 'matches', NESTED_CONTROL) && !htmlProp(el, 'isContentEditable')) nested = el;
        }
        if (nodeProp(n, 'parentNode') instanceof ShadowRoot) nested = null;
      }
      // A label whose control is the target activates it, unless the hit is on interactive content in the label.
      for (let n: Node | null = hit; n; n = composedParent(n)) {
        if (nodeProp(n, 'nodeType') !== 1) continue;
        const el = n as Element;
        if (elemProp(el, 'tagName') === 'LABEL') {
          if ((el as HTMLLabelElement).control === target) return { accepted: true, kind: 'label' as const };
          break;
        }
        if (elemCall(el, 'matches', INTERACTIVE)) break;
      }
      for (let n: Node | null = target; n; n = composedParent(n)) {
        if (n === hit) return { accepted: false, kind: 'ancestor' as const };
      }
      return { accepted: false, kind: 'other' as const };
    },

    /**
     * The dispatch-time guard. Listens on the window in the capture phase; when the trusted press arrives it re-applies
     * the hit rule at the event's coordinates. A failed check cancels the press and every later event of the sequence:
     * no default action happens and no handler at or below the window's capture phase runs. A page script that
     * registered its own capture listener on the window before the guard (the layer cannot run before the page's own
     * scripts) may already have seen that one event; the layer reports it that way, as delivery unknown.
     * In text mode it checks that every key and insertion of the sequence goes to the target, since a page handler
     * can move focus between two keys. Keys go to the element that has focus, so only the target itself is accepted:
     * a control inside it (a button in an editor) is another element, which nothing classified.
     */
    armGuard(target: Element, mode: 'pointer' | 'text', lifetimeMs = 4000, unfocused = false) {
      guard?.remove();
      const roots = rootsOf(target);
      // The document guard's target is the body: no focused element at all also counts as the body.
      const accepts = (hit: Element | null) =>
        hit === target || (unfocused && (!hit || hit === document.documentElement));
      const report: GuardReport =
        mode === 'text'
          ? { verdict: 'none', hit: '', seen: [], accepted: 0, strayKeyups: 0 }
          : { verdict: 'none', hit: '', seen: [], accepted: 0 };
      const cancel = (e: Event) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      const handler = (e: Event) => {
        if (!e.isTrusted) return;
        note(report, e.type);
        if (report.verdict === 'cancelled') return cancel(e);
        let hit: Element | null = null;
        if (mode === 'pointer') {
          if (!PRESSES.includes(e.type)) return;
          const m = e as MouseEvent;
          hit = deepElementFromPoint(m.clientX, m.clientY, roots);
        } else {
          hit = deepActiveElement(roots);
        }
        const accepted = mode === 'pointer' ? !!hit && api.hitAccepts(target, hit).accepted : accepts(hit);
        if (accepted) {
          report.verdict = 'passed';
          // Keys and insertions the target took, or, for the pointer, presses (each press is checked).
          if (mode === 'pointer' || e.type === 'keydown' || e.type === 'beforeinput') report.accepted!++;
          return;
        }
        // A keyup elsewhere follows a key the target accepted, whose default action moved focus (Tab, a
        // submission): withheld from the page, but not a failure. Any other event elsewhere cancels the sequence.
        if (mode === 'text' && e.type === 'keyup') {
          report.strayKeyups!++;
          return cancel(e);
        }
        report.verdict = 'cancelled';
        report.hit = hit ? api.describe(hit) : 'nothing';
        cancel(e);
      };
      install(
        mode === 'pointer' ? POINTER_EVENTS : TEXT_EVENTS,
        handler,
        lifetimeMs,
        report,
        mode === 'text' ? { target, roots, accepts } : undefined,
      );
    },

    /**
     * The text guard for keys sent with nothing focused: they go to the body, and must keep going there; a page that
     * moves focus to a control gets none of them.
     */
    armDocumentGuard(lifetimeMs = 4000) {
      api.armGuard(document.body ?? document.documentElement, 'text', lifetimeMs, true);
    },

    /**
     * In every frame other than the target's, during a key sequence: a correctly routed key never arrives here, so
     * any key or insertion is cancelled (a stray keyup is withheld, as in the text guard). Focus moved by the page into
     * another frame, out-of-process ones included, then gets none of the text.
     */
    armAwayGuard(lifetimeMs = 4000) {
      guard?.remove();
      const report: GuardReport = { verdict: 'none', hit: '', seen: [], strayKeyups: 0 };
      const handler = (e: Event) => {
        if (!e.isTrusted) return;
        note(report, e.type);
        if (report.verdict === 'none' && e.type !== 'keyup') {
          report.verdict = 'cancelled';
          report.hit = document.activeElement ? api.describe(document.activeElement) : 'nothing';
        }
        if (report.verdict !== 'cancelled') report.strayKeyups!++;
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      install(TEXT_EVENTS, handler, lifetimeMs, report);
    },

    /**
     * Withholds every trusted event of a kind from the page: for the release of a key or a mouse button that has to be
     * sent, so the browser does not keep it down, but must not take effect. A release is what activates (a click, Space
     * on a button), and no default action runs for a cancelled one (a page capture listener on the window that was
     * registered before the guard may still see it).
     */
    armBlockGuard(kind: 'pointer' | 'text', lifetimeMs = 4000) {
      guard?.remove();
      const report: GuardReport = { verdict: 'cancelled', hit: 'withheld', seen: [] };
      const handler = (e: Event) => {
        if (!e.isTrusted) return;
        note(report, e.type);
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      install(kind === 'pointer' ? POINTER_EVENTS : TEXT_EVENTS, handler, lifetimeMs, report);
    },

    /** Between two keys of a sequence: renews the text guard and says where focus is now. */
    stepGuard(lifetimeMs = 4000) {
      const g = guard;
      const copy = (r: GuardReport) => ({ ...r, seen: [...r.seen] });
      if (!g?.text) return { ...copy(lastReport), armed: false, focusOk: false, focus: '' };
      g.renew(lifetimeMs);
      const hit = deepActiveElement(g.text.roots);
      const focusOk = g.text.accepts(hit);
      return { ...copy(g.report), armed: true, focusOk, focus: hit ? api.describe(hit) : 'nothing' };
    },

    /** Renews whatever guard is armed in this world; false when none is. */
    renewGuard(lifetimeMs = 4000) {
      if (!guard) return false;
      guard.renew(lifetimeMs);
      return true;
    },

    /** In an ancestor frame of the target: a correctly routed press never arrives here, so any press is cancelled. */
    armAncestorGuard(lifetimeMs = 4000) {
      guard?.remove();
      const report: GuardReport = { verdict: 'none', hit: '', seen: [] };
      const handler = (e: Event) => {
        if (!e.isTrusted) return;
        note(report, e.type);
        if (report.verdict === 'none' && PRESSES.includes(e.type)) {
          report.verdict = 'cancelled';
          const m = e as MouseEvent;
          const hit = document.elementFromPoint(m.clientX, m.clientY);
          report.hit = hit ? api.describe(hit) : 'nothing';
        }
        if (report.verdict === 'cancelled') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      install(POINTER_EVENTS, handler, lifetimeMs, report);
    },

    readGuard() {
      return { ...lastReport, seen: [...lastReport.seen] };
    },

    disarm() {
      guard?.remove();
    },

    /** The frame's viewport in CSS pixels, scrollbars included (the layout viewport leaves them out). */
    viewport() {
      return { width: window.innerWidth, height: window.innerHeight };
    },

    /** Scroll offsets and sizes of an element, or of the document when el is null. */
    scrollInfo(el: Element | null) {
      const e = (el ?? document.scrollingElement ?? document.documentElement) as Element;
      return {
        top: e.scrollTop,
        left: e.scrollLeft,
        height: e.scrollHeight,
        width: e.scrollWidth,
        clientHeight: e.clientHeight,
        clientWidth: e.clientWidth,
      };
    },

    /** A short description of an element for messages: tag, id, classes, role and text (`shownText`). */
    describe(node: Node) {
      const el = (nodeProp(node, 'nodeType') === 1 ? node : nodeProp(node, 'parentElement')) as Element | null;
      if (!el) return (nodeProp(node, 'nodeName') as string).toLowerCase();
      let out = (elemProp(el, 'tagName') as string).toLowerCase();
      const id = elemProp(el, 'id');
      if (id) out += `#${id}`;
      const className = elemProp(el, 'className');
      const classes = typeof className === 'string' ? className.trim().split(/\s+/).filter(Boolean) : [];
      if (classes.length) out += `.${classes.slice(0, 3).join('.')}`;
      const role = attrOf(el, 'role');
      if (role) out += `[role=${role}]`;
      const text = shownText(el, 60);
      if (text) out += ` "${text}"`;
      return out;
    },
  };

  Object.defineProperty(g, '__nbProbe', { value: api, enumerable: false, configurable: false, writable: false });
}
