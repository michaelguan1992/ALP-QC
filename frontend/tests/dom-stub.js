// Minimal in-memory DOM for frontend unit tests. It covers the parts of document, window,
// elements, events, dialogs and simple selectors that the MasterQC UI modules use.
// Node built-ins only; install it before importing any frontend module that touches the DOM.

const BUBBLING_EVENTS = new Set(["click", "input", "change", "keydown", "submit"]);
const CANCELABLE_EVENTS = new Set(["cancel", "click", "submit", "keydown"]);

export class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = Boolean(options.bubbles);
    this.cancelable = Boolean(options.cancelable);
    this.detail = options.detail ?? null;
    this.key = options.key;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._propagationStopped = false;
    this._immediateStopped = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this._propagationStopped = true;
  }

  stopImmediatePropagation() {
    this._propagationStopped = true;
    this._immediateStopped = true;
  }
}

export class FakeCustomEvent extends FakeEvent {}

class FakeEventTarget {
  constructor() {
    this._listeners = new Map();
  }

  addEventListener(type, handler, options = {}) {
    if (typeof handler !== "function") return;
    const entries = this._listeners.get(type) ?? [];
    if (!entries.some((entry) => entry.handler === handler)) {
      entries.push({ handler, once: Boolean(options && options.once) });
    }
    this._listeners.set(type, entries);
  }

  removeEventListener(type, handler) {
    const entries = this._listeners.get(type);
    if (entries) this._listeners.set(type, entries.filter((entry) => entry.handler !== handler));
  }

  _runListeners(event) {
    const entries = this._listeners.get(event.type);
    if (!entries?.length) return false;
    for (const entry of [...entries]) {
      if (entry.once) this.removeEventListener(event.type, entry.handler);
      entry.handler.call(this, event);
      if (event._immediateStopped) return true;
    }
    return event._propagationStopped;
  }

  _eventPath() {
    return [this];
  }

  dispatchEvent(event) {
    event.target = event.target ?? this;
    for (const node of this._eventPath()) {
      event.currentTarget = node;
      if (node._runListeners(event)) break;
      if (!event.bubbles) break;
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class FakeNode extends FakeEventTarget {
  constructor(nodeType) {
    super();
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  _eventPath() {
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    return path;
  }

  get isConnected() {
    for (let node = this; node; node = node.parentNode) {
      if (node.nodeType === 9) return true;
    }
    return false;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value) {
    this.replaceChildren(value === null || value === undefined || value === "" ? [] : [String(value)]);
  }

  _insert(node) {
    if (node.parentNode) node.parentNode._remove(node);
    node.parentNode = this;
    this.childNodes.push(node);
  }

  _remove(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
  }

  _toNodes(items) {
    const nodes = [];
    for (const item of items.flat(Infinity)) {
      if (item === null || item === undefined || item === false) continue;
      if (item instanceof FakeNode) {
        // A document fragment hands over its children, as in the browser.
        if (item.nodeType === 11) nodes.push(...item.childNodes);
        else nodes.push(item);
      } else {
        nodes.push(new FakeText(String(item)));
      }
    }
    return nodes;
  }

  append(...items) {
    for (const node of this._toNodes(items)) this._insert(node);
  }

  replaceChildren(...items) {
    for (const child of [...this.childNodes]) this._remove(child);
    this.append(...items);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  remove() {
    this.parentNode?._remove(this);
  }

  querySelector(selector) {
    return selectAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return selectAll(this, selector);
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeDocumentFragment extends FakeNode {
  constructor() {
    super(11);
  }
}

function dataAttributeName(key) {
  return `data-${String(key).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1);
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.style = {};
    this._value = undefined;
    if (this.localName === "dialog") this.open = false;
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get className() {
    return this.getAttribute("class") ?? "";
  }

  set className(value) {
    this.setAttribute("class", value);
  }

  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name) => names().includes(name),
      add: (...added) => { element.className = [...new Set([...names(), ...added])].join(" "); },
      remove: (...removed) => { element.className = names().filter((name) => !removed.includes(name)).join(" "); },
    };
  }

  get dataset() {
    const element = this;
    return new Proxy({}, {
      get(_target, key) {
        return typeof key === "string" ? element.getAttribute(dataAttributeName(key)) ?? undefined : undefined;
      },
      set(_target, key, value) {
        element.setAttribute(dataAttributeName(key), value);
        return true;
      },
      deleteProperty(_target, key) {
        element.removeAttribute(dataAttributeName(key));
        return true;
      },
    });
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get value() {
    if (this._value !== undefined) return this._value;
    return this.localName === "textarea" ? this.textContent : "";
  }

  set value(value) {
    this._value = value === null || value === undefined ? "" : String(value);
  }

  get validity() {
    return { badInput: false, valid: true };
  }

  reportValidity() {
    return true;
  }

  checkValidity() {
    return true;
  }

  focus() {}

  blur() {}

  click() {
    this.dispatchEvent(new FakeEvent("click", { bubbles: true, cancelable: true }));
  }

  showModal() {
    this.open = true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new FakeEvent("close"));
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    for (let node = this; node && node.nodeType === 1; node = node.parentNode) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(9);
    this.body = null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createTextNode(text) {
    return new FakeText(String(text));
  }

  createDocumentFragment() {
    return new FakeDocumentFragment();
  }
}

// Supports type, #id, .class, [attr], [attr="value"] and descendant combinators.
function parseSelector(selector) {
  return String(selector).trim().split(/\s+/).map((part) => {
    const compound = { tag: null, id: null, classes: [], attributes: [] };
    for (const token of part.matchAll(/([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
      if (token[1]) compound.tag = token[1].toLowerCase();
      else if (token[2]) compound.id = token[2];
      else if (token[3]) compound.classes.push(token[3]);
      else if (token[4]) compound.attributes.push({ name: token[4].toLowerCase(), value: token[5] ?? token[6] ?? token[7] });
    }
    return compound;
  });
}

function matchesCompound(element, compound) {
  if (compound.tag && element.localName !== compound.tag) return false;
  if (compound.id && element.id !== compound.id) return false;
  for (const className of compound.classes) {
    if (!element.classList.contains(className)) return false;
  }
  for (const attribute of compound.attributes) {
    const actual = element.getAttribute(attribute.name);
    if (actual === null) return false;
    if (attribute.value !== undefined && actual !== attribute.value) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  const parts = parseSelector(selector);
  if (!matchesCompound(element, parts.at(-1))) return false;
  let index = parts.length - 2;
  for (let node = element.parentNode; node && index >= 0; node = node.parentNode) {
    if (node.nodeType === 1 && matchesCompound(node, parts[index])) index -= 1;
  }
  return index < 0;
}

function selectAll(root, selector) {
  const matched = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (matchesSelector(child, selector)) matched.push(child);
      visit(child);
    }
  };
  visit(root);
  return matched;
}

/** Installs the fake DOM as globals and returns handles for tests. */
export function installDomStub({ url = "http://127.0.0.1:4173/" } = {}) {
  const document = new FakeDocument();
  const body = document.createElement("body");
  document.append(body);
  document.body = body;
  const dialogHost = document.createElement("div");
  dialogHost.id = "dialog-host";
  const toastHost = document.createElement("div");
  toastHost.id = "toast-host";
  body.append(dialogHost, toastHost);

  const window = new FakeEventTarget();
  Object.assign(window, {
    setTimeout,
    clearTimeout,
    location: new URL(url),
    getSelection: () => null,
    confirm: () => true,
  });

  Object.assign(globalThis, {
    document,
    window,
    Node: FakeNode,
    Element: FakeElement,
    Event: FakeEvent,
    CustomEvent: FakeCustomEvent,
  });

  return {
    document,
    window,
    body,
    dialogHost,
    toastHost,
    /** Dispatches an event with bubbling and cancelability chosen like the browser's defaults. */
    fire(target, type, init = {}) {
      const event = new FakeEvent(type, {
        bubbles: BUBBLING_EVENTS.has(type),
        cancelable: CANCELABLE_EVENTS.has(type),
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    },
    click(target) {
      return this.fire(target, "click");
    },
    setValue(input, value) {
      input.value = value;
      this.fire(input, "input");
    },
    dialog() {
      return document.querySelector("#qc-dialog");
    },
  };
}

/** Button lookup by visible text inside a subtree. */
export function findButton(root, label) {
  return root.querySelectorAll("button").find((candidate) => candidate.textContent === label) ?? null;
}

/** Lets pending promise continuations and the manual-save queue settle. */
export async function flush(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
