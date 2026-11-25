// Renderer side of the C# language server: document sync, diagnostics and Monaco providers.
import { monaco } from './monaco.js';
import * as cv from './conv.js';
import { UNITY_ATTRIBUTE_NAMES } from './unity-completions.js';

const api = window.papyrus.lsp;
let reqSeq = 1;
const INH_CACHE_MS = 10000; // inheritance lens counts for an unchanged file are reused this long
const LENS_KICK_MS = [400, 1500]; // re-request lenses at these delays after a file is first shown

export class LspClient {
  constructor({ onStatus, onApplyEdit, onCommand, onShowDocument, onMessage }) {
    this.status = { state: 'stopped' };
    this.caps = null;
    this.kind = null;
    this.docs = new Map(); // uri -> { model, version, sub }
    this.diagRegs = new Map(); // registration id -> identifier
    this.pullResults = new Map(); // uri -> Map(identifier -> {resultId, items})
    this.lastDiagnostics = new Map(); // uri -> lsp diagnostics (all identifiers merged)
    this.diagVersion = new Map(); // uri -> document version the diagnostics are for
    this.semanticDoneFor = new Map(); // uri -> version whose colors were re-asked after its diagnostics
    this.onDiagnostics = null; // (model, diagnostics) once they're shown (using cleanup)
    this.providers = [];
    this.lensKickedFor = null; // model whose lenses were last re-requested after being shown
    this.onStatus = onStatus;
    this.onApplyEdit = onApplyEdit;
    this.onCommand = onCommand;
    this.onShowDocument = onShowDocument;
    this.onMessage = onMessage;
    this.pullTimers = new Map();
    this.pullRetries = new Map(); // uri -> incomplete pull rounds in a row
    this.ready = false;
    // workspace pull diagnostics (every file of the solution, see startWorkspaceDiagnostics)
    this.wsDiagRegs = new Map(); // registration id -> identifier (registrations with workspaceDiagnostics)
    this.wsResults = new Map(); // identifier -> Map(uri -> { resultId, items })
    this.wsLoops = new Set(); // identifiers being polled
    this.wsGen = 0; // bumped on start/stop: older loops end
    this.workspaceErrors = new Map(); // uri -> error count, from the workspace results
    this.onWorkspaceDiagnostics = null;

    api.onStatus((st) => this.handleStatus(st));
    api.onNotification(({ method, params }) => this.handleNotification(method, params));
  }

  get running() {
    return ['loading', 'ready', 'restoring'].includes(this.status.state) && !!this.caps;
  }

  async start() {
    this.caps = null;
    this.ready = false;
    this.diagRegs.clear();
    this.resetWorkspaceDiagnostics();
    const res = await api.start();
    if (res && res.ok) {
      this.caps = res.capabilities || {};
      this.kind = res.kind;
      this.registerProviders();
      for (const d of this.docs.values()) this.sendOpen(d);
      this.pullAll();
    }
    return res;
  }

  async stop() {
    this.caps = null;
    this.resetWorkspaceDiagnostics();
    this.disposeProviders();
    await api.stop();
  }

  handleStatus(st) {
    this.status = st;
    if (st.state === 'ready' && !this.ready) {
      this.ready = true;
      setTimeout(() => { this.pullAll(); this.startWorkspaceDiagnostics(); }, 300);
    }
    if (st.state === 'error' || st.state === 'stopped') this.ready = false;
    this.onStatus && this.onStatus(st);
  }

  handleNotification(method, params) {
    switch (method) {
      case 'textDocument/publishDiagnostics': {
        const d = this.docs.get(normUri(params.uri));
        this.lastDiagnostics.set(normUri(params.uri), params.diagnostics || []);
        const model = d ? d.model : monaco.editor.getModel(monaco.Uri.parse(params.uri));
        // without a version they may be for older text: fresh only for a push-only server (no pulls)
        this.diagVersion.set(normUri(params.uri), params.version != null ? params.version : d && !this.pullIdentifiers().length ? d.version : -1);
        if (model) monaco.editor.setModelMarkers(model, 'lsp', (params.diagnostics || []).filter(cv.visibleDiagnostic).map(cv.toMarker));
        if (model && this.onDiagnostics) this.onDiagnostics(model, params.diagnostics || []);
        this.onDocsChange && this.onDocsChange(); // explorer error marks (file-errors.js)
        break;
      }
      case '$papyrus/registerCapability':
        for (const r of params.registrations || []) {
          if (r.method === 'textDocument/diagnostic') {
            const o = r.registerOptions || {};
            this.diagRegs.set(r.id, o.identifier || '');
            if (o.workspaceDiagnostics) this.wsDiagRegs.set(r.id, o.identifier || '');
            setTimeout(() => { this.pullAll(); if (this.ready) this.startWorkspaceDiagnostics(); }, 50);
          }
        }
        break;
      case '$papyrus/unregisterCapability':
        for (const r of params.unregisterations || params.unregistrations || []) { this.diagRegs.delete(r.id); this.wsDiagRegs.delete(r.id); }
        break;
      case 'workspace/diagnostic/refresh':
      case 'workspace/projectInitializationComplete':
        this.pullAll();
        if (method === 'workspace/projectInitializationComplete') this.refreshSemantic();
        break;
      case 'workspace/semanticTokens/refresh':
        this.refreshSemantic();
        break;
      case 'workspace/inlayHint/refresh':
        this.inlayEmitter && this.inlayEmitter.fire();
        break;
      case 'workspace/codeLens/refresh':
        this.codeLensEmitter && this.codeLensEmitter.fire(this.codeLensProvider);
        break;
      case '$papyrus/applyEdit':
        this.onApplyEdit && this.onApplyEdit(params.edit);
        break;
      case '$papyrus/showDocument':
        this.onShowDocument && this.onShowDocument(params);
        break;
      case 'window/showMessage':
        this.onMessage && this.onMessage(params);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ requests
  request(method, params, token) {
    return this.send(method, params, token).then((r) => (r.error ? null : r.result));
  }

  // Like request() but retries when the server answers ContentModified (the document changed
  // while it was working, e.g. fast typing). Used for completion so results are never dropped.
  async requestRetry(method, params, token, retries = 3) {
    for (let i = 0; ; i++) {
      const r = await this.send(method, params, token);
      if (!r.error) return r.result;
      if (r.error.code !== -32801 || i >= retries || (token && token.isCancellationRequested)) return null;
      await new Promise((res) => setTimeout(res, 40));
      if (token && token.isCancellationRequested) return null;
    }
  }

  send(method, params, token) {
    if (!this.caps) return Promise.resolve({ error: { message: 'not running' } });
    const id = reqSeq++;
    let sub = null;
    if (token) {
      if (token.isCancellationRequested) return Promise.resolve({ error: { message: 'cancelled', code: -32800 } });
      sub = token.onCancellationRequested(() => api.cancel(id));
    }
    return api.request(method, params, id)
      .then((r) => {
        if (r && r.error) {
          if (window.__lspDebug) console.log('[lsp-error]', method, JSON.stringify(r.error));
          // -32800 RequestCancelled, -32801 ContentModified: expected while typing
          if (r.error.code !== -32800 && r.error.code !== -32801 && !/cancel/i.test(r.error.message)) console.warn(`[lsp] ${method} failed`, r.error.message);
          return r;
        }
        return { result: r ? r.result : null };
      })
      .catch((err) => ({ error: { message: String(err) } }))
      .finally(() => sub && sub.dispose());
  }

  notify(method, params) {
    if (this.caps) api.notify(method, params);
  }

  // ------------------------------------------------------------------ documents
  isCSharp(model) {
    return model.getLanguageId() === 'csharp' && model.uri.scheme === 'file';
  }

  open(model) {
    if (!this.isCSharp(model)) return;
    const uri = model.uri.toString();
    if (this.docs.has(uri)) return;
    const d = { model, version: 1, sub: null };
    d.sub = model.onDidChangeContent((e) => {
      d.version++;
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: d.version },
        contentChanges: e.changes.map((c) => ({ range: cv.toLspRange(c.range), rangeLength: c.rangeLength, text: c.text })),
      });
      this.schedulePull(uri);
    });
    this.docs.set(uri, d);
    this.sendOpen(d);
    this.onDocsChange && this.onDocsChange();
  }

  sendOpen(d) {
    if (!this.caps) return;
    const uri = d.model.uri.toString();
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'csharp', version: d.version, text: d.model.getValue() } });
    this.schedulePull(uri, 100);
  }

  close(model) {
    const uri = model.uri.toString();
    const d = this.docs.get(uri);
    if (!d) return;
    d.sub.dispose();
    this.docs.delete(uri);
    this.pullResults.delete(uri);
    this.pullRetries.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
    this.onDocsChange && this.onDocsChange();
  }

  saved(model) {
    const uri = model.uri.toString();
    if (this.docs.has(uri)) this.notify('textDocument/didSave', { textDocument: { uri } });
  }

  // A closed C# file was rewritten on disk by us (e.g. a rename that touched files without a tab).
  // Roslyn keeps its own copy of closed files and doesn't notice our write, so the open files keep
  // resolving against the old text: renamed symbols lose their color and completion. Hand it the
  // new text (open + close makes it take this version) and tell it the file changed.
  syncDiskWrite(rawUri, text) {
    const uri = normUri(rawUri);
    if (!this.caps || !/\.cs$/i.test(uri) || this.docs.has(uri)) return; // open docs sync via didChange
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'csharp', version: 1, text } });
    this.notify('textDocument/didClose', { textDocument: { uri } });
    this.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 2 }] });
  }

  // Re-ask Roslyn for colors and diagnostics of the open files after other files changed.
  refreshAfterExternalEdit() {
    this.refreshSemantic();
    this.pullAll();
  }

  /** Diagnostics for the model's current text (not an older version still on the way)? */
  diagnosticsFresh(model) {
    const uri = normUri(model.uri.toString());
    const d = this.docs.get(uri);
    return !!d && this.diagVersion.get(uri) === d.version && this.lastDiagnostics.has(uri);
  }

  diagnosticsFor(model) {
    return this.lastDiagnostics.get(normUri(model.uri.toString())) || [];
  }

  /**
   * Does the file have code #if leaves out (Roslyn's excludedCode semantic tokens)? null when it
   * can't tell (no such token type, request failed).
   */
  async hasExcludedCode(model) {
    const legend = this.caps && this.caps.semanticTokensProvider && this.caps.semanticTokensProvider.legend;
    const idx = legend ? (legend.tokenTypes || []).indexOf('excludedCode') : -1;
    if (idx < 0) return null;
    const r = await this.request('textDocument/semanticTokens/full', { textDocument: { uri: model.uri.toString() } });
    if (!r || !Array.isArray(r.data)) return null;
    for (let i = 3; i < r.data.length; i += 5) if (r.data[i] === idx) return true;
    return false;
  }

  pullNow(model) {
    this.schedulePull(normUri(model.uri.toString()), 0);
  }

  // ------------------------------------------------------------------ pull diagnostics
  pullIdentifiers() {
    const ids = new Set(this.diagRegs.values());
    if (!ids.size && this.caps && this.caps.diagnosticProvider) ids.add(this.caps.diagnosticProvider.identifier || '');
    return [...ids];
  }

  schedulePull(uri, delay = 450) {
    if (!this.pullIdentifiers().length) return;
    clearTimeout(this.pullTimers.get(uri));
    this.pullTimers.set(uri, setTimeout(() => this.pull(uri), delay));
  }

  pullAll() {
    for (const uri of this.docs.keys()) this.schedulePull(uri, 50);
  }

  async pull(uri) {
    const d = this.docs.get(uri);
    if (!d || !this.caps) return;
    const version = d.version;
    let store = this.pullResults.get(uri);
    if (!store) this.pullResults.set(uri, (store = new Map()));
    // Each identifier (syntax, compiler, analyzers...) answers on its own. One that was cancelled /
    // hit ContentModified still holds the previous text's items (other line numbers): this round
    // is then incomplete and must not count as the diagnostics of this version (the using cleanup
    // removes lines by them).
    let incomplete = false;
    await Promise.all(this.pullIdentifiers().map(async (identifier) => {
      const prev = store.get(identifier);
      const params = { textDocument: { uri }, previousResultId: prev ? prev.resultId : undefined };
      if (identifier) params.identifier = identifier;
      const r = await this.send('textDocument/diagnostic', params);
      const res = r.error ? null : r.result;
      if (!res) {
        if (r.error && (r.error.code === -32800 || r.error.code === -32801 || /cancel/i.test(r.error.message || ''))) incomplete = true;
        else store.delete(identifier); // not supported for this file: nothing from it
        return;
      }
      if (res.kind === 'unchanged') {
        if (prev) prev.resultId = res.resultId || prev.resultId;
        else incomplete = true; // nothing to keep: ask again in full
      } else {
        store.set(identifier, { resultId: res.resultId, items: res.items || [] });
      }
    }));
    const cur = this.docs.get(uri);
    if (!cur || cur.version !== version) return; // stale; a newer pull is scheduled
    if (incomplete) {
      // ask again soon; after a few tries show what there is (squiggles), still not as fresh
      const tries = (this.pullRetries.get(uri) || 0) + 1;
      this.pullRetries.set(uri, tries);
      if (tries <= 5) { this.schedulePull(uri, 300 * tries); return; }
    } else this.pullRetries.delete(uri);
    const all = [];
    for (const v of store.values()) all.push(...v.items);
    this.lastDiagnostics.set(uri, all);
    this.diagVersion.set(uri, incomplete ? -1 : version); // incomplete: shown, never "fresh"
    monaco.editor.setModelMarkers(cur.model, 'lsp', all.filter(cv.visibleDiagnostic).map(cv.toMarker));
    if (this.onDiagnostics) this.onDiagnostics(cur.model, all);
    this.onDocsChange && this.onDocsChange();
    // The colors asked right after an edit can be Roslyn's half-ready answer (project still loading or
    // reloading, names not bound yet: white). With this version's diagnostics in, Roslyn has analyzed
    // it, so the colors are asked once more for it.
    if (!incomplete && this.semanticDoneFor.get(uri) !== version) {
      this.semanticDoneFor.set(uri, version);
      this.refreshSemantic();
    }
  }

  // ------------------------------------------------------------------ workspace diagnostics
  // Errors of files that aren't open (for the explorer). Roslyn answers workspace/diagnostic with
  // what changed since the result ids we send; with nothing new it holds the request until
  // something changes (long poll), so each identifier runs a loop of back-to-back requests.
  workspaceIdentifiers() {
    // Roslyn also registers 'enc' / 'HotReloadDiagnostics' (debug sessions only): they answer at once, empty
    const ids = new Set([...this.wsDiagRegs.values()].filter((id) => !/^(enc|HotReloadDiagnostics)$/i.test(id)));
    const dp = this.caps && this.caps.diagnosticProvider;
    if (!ids.size && dp && dp.workspaceDiagnostics) ids.add(dp.identifier || '');
    return [...ids];
  }

  resetWorkspaceDiagnostics() {
    this.wsGen++;
    this.wsDiagRegs.clear();
    this.wsResults.clear();
    this.wsLoops.clear();
    if (this.wsCancel) { this.wsCancel.cancel(); this.wsCancel = null; }
    if (this.workspaceErrors.size) {
      this.workspaceErrors = new Map();
      this.onWorkspaceDiagnostics && this.onWorkspaceDiagnostics();
    }
  }

  startWorkspaceDiagnostics() {
    if (!this.caps) return;
    if (!this.wsCancel) this.wsCancel = new monaco.CancellationTokenSource();
    for (const id of this.workspaceIdentifiers()) {
      if (!this.wsLoops.has(id)) this.workspaceLoop(id, this.wsGen, this.wsCancel.token);
    }
  }

  async workspaceLoop(identifier, gen, token) {
    this.wsLoops.add(identifier);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let store = this.wsResults.get(identifier);
    if (!store) this.wsResults.set(identifier, (store = new Map()));
    while (gen === this.wsGen && this.caps && this.workspaceIdentifiers().includes(identifier)) {
      const t0 = Date.now();
      const params = { previousResultIds: [...store].filter(([, v]) => v.resultId).map(([uri, v]) => ({ uri, value: v.resultId })) };
      if (identifier) params.identifier = identifier;
      const r = await this.send('workspace/diagnostic', params, token);
      if (gen !== this.wsGen) return;
      if (r.error || !r.result) {
        await wait(r.error && r.error.code === -32801 ? 500 : 5000); // ContentModified: soon again
        continue;
      }
      let changed = false;
      for (const rep of r.result.items || []) {
        if (!rep || !rep.uri) continue;
        const uri = normUri(rep.uri);
        if (rep.kind === 'unchanged') {
          const prev = store.get(uri);
          if (prev) prev.resultId = rep.resultId || prev.resultId;
        } else {
          store.set(uri, { resultId: rep.resultId, items: rep.items || [] });
          changed = true;
        }
      }
      if (changed) this.updateWorkspaceErrors();
      // a server that answers at once instead of waiting: don't spin
      const spent = Date.now() - t0;
      if (spent < 3000) await wait(3000 - spent);
    }
    if (gen === this.wsGen) this.wsLoops.delete(identifier);
  }

  updateWorkspaceErrors() {
    const errors = new Map();
    for (const store of this.wsResults.values()) {
      for (const [uri, v] of store) {
        const n = v.items.filter((d) => (d.severity || 1) === 1).length;
        if (n) errors.set(uri, (errors.get(uri) || 0) + n);
      }
    }
    this.workspaceErrors = errors;
    this.onWorkspaceDiagnostics && this.onWorkspaceDiagnostics();
  }

  /** Is this file open in the client (its own pulled diagnostics are newer than the workspace's)? */
  isOpenUri(uri) {
    return this.docs.has(normUri(uri));
  }

  // ------------------------------------------------------------------ providers
  disposeProviders() {
    this.providers.forEach((p) => p.dispose());
    this.providers = [];
  }

  refreshSemantic() {
    if (this.semanticEmitter) this.semanticEmitter.fire();
  }

  /** No colors came back (server busy / failed): ask again a few times, a little later each time. */
  retrySemanticSoon() {
    if (this.semanticRetryTimer || (this.semanticRetries || 0) >= 5) return;
    this.semanticRetries = (this.semanticRetries || 0) + 1;
    this.semanticRetryTimer = setTimeout(() => {
      this.semanticRetryTimer = null;
      this.refreshSemantic();
    }, 400 * this.semanticRetries);
  }

  registerProviders() {
    this.disposeProviders();
    const caps = this.caps || {};
    const L = monaco.languages;
    const sel = 'csharp';
    const self = this;
    const doc = (model) => ({ uri: model.uri.toString() });
    const add = (d) => this.providers.push(d);

    // --- completion
    if (caps.completionProvider) {
      const cp = caps.completionProvider;
      add(L.registerCompletionItemProvider(sel, {
        triggerCharacters: cp.triggerCharacters || ['.'],
        async provideCompletionItems(model, position, context, token) {
          const triggerKind = context.triggerKind === L.CompletionTriggerKind.Invoke ? 1
            : context.triggerKind === L.CompletionTriggerKind.TriggerCharacter ? 2 : 3;
          const res = await self.requestRetry('textDocument/completion', {
            textDocument: doc(model),
            position: cv.toPos(position),
            context: { triggerKind, triggerCharacter: context.triggerCharacter },
          }, token);
          if (!res) return { suggestions: [] };
          const list = Array.isArray(res) ? { items: res, isIncomplete: false } : res;
          const defaults = list.itemDefaults || {};
          const word = model.getWordUntilPosition(position);
          const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
          const suggestions = (list.items || []).map((it) => convertCompletion(it, defaults, fallback, model));
          return { suggestions, incomplete: !!list.isIncomplete };
        },
        async resolveCompletionItem(item, token) {
          if (!cp.resolveProvider || !item.__lsp) return item;
          const r = await self.request('completionItem/resolve', item.__lsp, token);
          if (!r) return item;
          if (r.documentation) item.documentation = cv.markdown(r.documentation);
          if (r.detail) item.detail = r.detail;
          if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map((e) => ({ range: cv.toRange(e.range), text: e.newText }));
          if (r.command) item.command = { id: 'papyrus.lsp.command', title: r.command.title || '', arguments: [r.command] };
          return item;
        },
      }));
    }

    // --- hover
    if (caps.hoverProvider) {
      add(L.registerHoverProvider(sel, {
        async provideHover(model, position, token) {
          const r = await self.requestRetry('textDocument/hover', { textDocument: doc(model), position: cv.toPos(position) }, token);
          if (!r || !r.contents) return null;
          const md = cv.markdown(r.contents);
          if (!md || !md.value.trim()) return null;
          return { contents: [md], range: r.range ? cv.toRange(r.range) : undefined };
        },
      }));
    }

    // --- signature help
    if (caps.signatureHelpProvider) {
      const sp = caps.signatureHelpProvider;
      add(L.registerSignatureHelpProvider(sel, {
        signatureHelpTriggerCharacters: sp.triggerCharacters || ['(', ','],
        signatureHelpRetriggerCharacters: sp.retriggerCharacters || [','],
        async provideSignatureHelp(model, position, token, context) {
          const r = await self.requestRetry('textDocument/signatureHelp', {
            textDocument: doc(model),
            position: cv.toPos(position),
            context: {
              triggerKind: context.triggerKind,
              triggerCharacter: context.triggerCharacter,
              isRetrigger: context.isRetrigger,
            },
          }, token);
          if (!r || !r.signatures || !r.signatures.length) return null;
          return {
            value: {
              signatures: r.signatures.map((s) => ({
                label: s.label,
                documentation: cv.markdown(s.documentation) || undefined,
                parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: cv.markdown(p.documentation) || undefined })),
                activeParameter: s.activeParameter,
              })),
              activeSignature: r.activeSignature || 0,
              activeParameter: r.activeParameter || 0,
            },
            dispose() {},
          };
        },
      }));
    }

    // --- navigation
    const locs = async (method, model, position, token) => {
      const r = await self.request(method, { textDocument: doc(model), position: cv.toPos(position) }, token);
      const list = toLocations(r);
      await self.ensureModels(list.map((l) => l.uri));
      return list;
    };
    if (caps.definitionProvider) add(L.registerDefinitionProvider(sel, { provideDefinition: (m, p, t) => locs('textDocument/definition', m, p, t) }));
    if (caps.typeDefinitionProvider) add(L.registerTypeDefinitionProvider(sel, { provideTypeDefinition: (m, p, t) => locs('textDocument/typeDefinition', m, p, t) }));
    if (caps.implementationProvider) add(L.registerImplementationProvider(sel, { provideImplementation: (m, p, t) => locs('textDocument/implementation', m, p, t) }));
    if (caps.referencesProvider) {
      add(L.registerReferenceProvider(sel, {
        async provideReferences(model, position, context, token) {
          const r = await self.request('textDocument/references', { textDocument: doc(model), position: cv.toPos(position), context: { includeDeclaration: context.includeDeclaration } }, token);
          const list = toLocations(r);
          await self.ensureModels([...new Set(list.map((l) => l.uri.toString()))].slice(0, 40).map((u) => monaco.Uri.parse(u)));
          return list.filter((l) => monaco.editor.getModel(l.uri));
        },
      }));
    }
    if (caps.documentHighlightProvider) {
      add(L.registerDocumentHighlightProvider(sel, {
        async provideDocumentHighlights(model, position, token) {
          const r = await self.request('textDocument/documentHighlight', { textDocument: doc(model), position: cv.toPos(position) }, token);
          return (r || []).map((h) => ({ range: cv.toRange(h.range), kind: h.kind === 3 ? L.DocumentHighlightKind.Write : h.kind === 2 ? L.DocumentHighlightKind.Read : L.DocumentHighlightKind.Text }));
        },
      }));
    }
    if (caps.documentSymbolProvider) {
      add(L.registerDocumentSymbolProvider(sel, {
        displayName: 'C#',
        async provideDocumentSymbols(model, token) {
          const r = await self.documentSymbols(model, token);
          return r.map(function conv(s) {
            return {
              name: s.name, detail: s.detail || '', kind: cv.symbolKind(s.kind), tags: [],
              range: cv.toRange(s.range), selectionRange: cv.toRange(s.selectionRange), children: (s.children || []).map(conv),
            };
          });
        },
      }));
    }

    // --- code actions (Alt+Enter)
    if (caps.codeActionProvider) {
      const resolvable = typeof caps.codeActionProvider === 'object' && caps.codeActionProvider.resolveProvider;
      add(L.registerCodeActionProvider(sel, {
        async provideCodeActions(model, range, context, token) {
          const uri = model.uri.toString();
          const diags = (self.lastDiagnostics.get(uri) || []).filter((d) => cv.toRange(d.range).intersectRanges(range));
          const r = await self.request('textDocument/codeAction', {
            textDocument: doc(model),
            range: cv.toLspRange(range),
            context: { diagnostics: diags, only: context.only ? [context.only] : undefined, triggerKind: context.trigger === 1 ? 1 : 2 },
          }, token);
          const actions = (r || []).filter((a) => !(a.command && /fixAllCodeAction/.test(a.command.command || a.command)))
            .map((a) => {
              if (typeof a.command === 'string') return { title: a.title, command: { id: 'papyrus.lsp.command', title: a.title, arguments: [a] } };
              const act = { title: a.title, kind: a.kind, isPreferred: a.isPreferred, diagnostics: (a.diagnostics || []).map(cv.toMarker), __lsp: a };
              if (a.disabled) act.disabled = a.disabled.reason;
              if (a.edit) act.edit = self.toMonacoEdit(a.edit);
              if (a.command) act.command = { id: 'papyrus.lsp.command', title: a.command.title || a.title, arguments: [a.command] };
              return act;
            });
          return { actions, dispose() {} };
        },
        async resolveCodeAction(action, token) {
          if (!resolvable || !action.__lsp || action.edit) return action;
          const r = await self.request('codeAction/resolve', action.__lsp, token);
          if (r && r.edit) action.edit = self.toMonacoEdit(r.edit);
          if (r && r.command) action.command = { id: 'papyrus.lsp.command', title: r.command.title || action.title, arguments: [r.command] };
          return action;
        },
      }, { providedCodeActionKinds: ['quickfix', 'refactor', 'source'] }));
    }

    // --- formatting
    const edits = (r) => (r || []).map((e) => ({ range: cv.toRange(e.range), text: e.newText }));
    const fmtOpts = (o) => ({ tabSize: o.tabSize, insertSpaces: o.insertSpaces, trimTrailingWhitespace: true, insertFinalNewline: false });
    if (caps.documentFormattingProvider) {
      add(L.registerDocumentFormattingEditProvider(sel, {
        async provideDocumentFormattingEdits(model, options, token) {
          return edits(await self.request('textDocument/formatting', { textDocument: doc(model), options: fmtOpts(options) }, token));
        },
      }));
    }
    if (caps.documentRangeFormattingProvider) {
      add(L.registerDocumentRangeFormattingEditProvider(sel, {
        async provideDocumentRangeFormattingEdits(model, range, options, token) {
          return edits(await self.request('textDocument/rangeFormatting', { textDocument: doc(model), range: cv.toLspRange(range), options: fmtOpts(options) }, token));
        },
      }));
    }
    if (caps.documentOnTypeFormattingProvider) {
      const o = caps.documentOnTypeFormattingProvider;
      add(L.registerOnTypeFormattingEditProvider(sel, {
        autoFormatTriggerCharacters: [o.firstTriggerCharacter, ...(o.moreTriggerCharacter || [])],
        async provideOnTypeFormattingEdits(model, position, ch, options, token) {
          return edits(await self.request('textDocument/onTypeFormatting', { textDocument: doc(model), position: cv.toPos(position), ch, options: fmtOpts(options) }, token));
        },
      }));
    }

    // --- rename
    if (caps.renameProvider) {
      const prepare = typeof caps.renameProvider === 'object' && caps.renameProvider.prepareProvider;
      add(L.registerRenameProvider(sel, {
        async provideRenameEdits(model, position, newName, token) {
          const r = await self.request('textDocument/rename', { textDocument: doc(model), position: cv.toPos(position), newName }, token);
          if (!r) return { edits: [], rejectReason: '이름을 바꿀 수 없는 위치예요' };
          const res = self.toMonacoEdit(r);
          // Unity: a renamed serialized field gets [FormerlySerializedAs] (unity-features.js)
          if (self.onRename) { try { await self.onRename(model, position, newName, res); } catch { /* keep Roslyn's edit */ } }
          return res;
        },
        resolveRenameLocation: prepare ? async (model, position, token) => {
          const r = await self.request('textDocument/prepareRename', { textDocument: doc(model), position: cv.toPos(position) }, token);
          if (!r) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: '이름을 바꿀 수 없는 위치예요' };
          if (r.range) return { range: cv.toRange(r.range), text: r.placeholder || model.getValueInRange(cv.toRange(r.range)) };
          if (r.start) {
            const range = cv.toRange(r);
            return { range, text: model.getValueInRange(range) };
          }
          const w = model.getWordAtPosition(position);
          return w ? { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), text: w.word } : null;
        } : undefined,
      }));
    }

    // --- folding, selection
    if (caps.foldingRangeProvider) {
      add(L.registerFoldingRangeProvider(sel, {
        async provideFoldingRanges(model, _ctx, token) {
          const r = await self.request('textDocument/foldingRange', { textDocument: doc(model) }, token);
          return (r || []).map((f) => ({
            start: f.startLine + 1,
            end: f.endLine + 1,
            kind: f.kind ? L.FoldingRangeKind.fromValue(f.kind) : undefined,
          }));
        },
      }));
    }
    if (caps.selectionRangeProvider) {
      add(L.registerSelectionRangeProvider(sel, {
        async provideSelectionRanges(model, positions, token) {
          const r = await self.request('textDocument/selectionRange', { textDocument: doc(model), positions: positions.map(cv.toPos) }, token);
          return (r || []).map((sr) => {
            const out = [];
            for (let cur = sr; cur; cur = cur.parent) out.push({ range: cv.toRange(cur.range) });
            return out;
          });
        },
      }));
    }

    // --- semantic tokens
    if (caps.semanticTokensProvider && caps.semanticTokensProvider.legend) {
      const legend = caps.semanticTokensProvider.legend;
      const clean = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const monacoLegend = { tokenTypes: legend.tokenTypes.map(clean), tokenModifiers: legend.tokenModifiers.map(clean) };
      this.semanticEmitter = new monaco.Emitter();
      const full = caps.semanticTokensProvider.full;
      if (full) {
        add(L.registerDocumentSemanticTokensProvider(sel, {
          onDidChange: this.semanticEmitter.event,
          getLegend: () => monacoLegend,
          async provideDocumentSemanticTokens(model, _lastId, token) {
            const r = await self.request('textDocument/semanticTokens/full', { textDocument: doc(model) }, token);
            if (!r || !r.data) return null;
            return { data: new Uint32Array(r.data), resultId: r.resultId };
          },
          releaseDocumentSemanticTokens() {},
        }));
      }
      if (caps.semanticTokensProvider.range) {
        // Roslyn only answers ranges (full: false). Monaco re-asks a range provider only when the view
        // scrolls or the text changes, or when the provider fires onDidChange: without it Roslyn's
        // refresh (project loaded, .csproj reloaded after Unity regenerated it) never reached the
        // editor, and names stayed white until the user touched the file.
        add(L.registerDocumentRangeSemanticTokensProvider(sel, {
          onDidChange: this.semanticEmitter.event,
          getLegend: () => monacoLegend,
          async provideDocumentRangeSemanticTokens(model, range, token) {
            // ContentModified (Roslyn still on the previous text): ask again instead of leaving the
            // edited lines without colors
            const r = await self.requestRetry('textDocument/semanticTokens/range', { textDocument: doc(model), range: cv.toLspRange(range) }, token);
            if (token && token.isCancellationRequested) return null;
            if (!r || !r.data) { self.retrySemanticSoon(); return null; }
            self.semanticRetries = 0;
            return { data: new Uint32Array(r.data), resultId: r.resultId };
          },
        }));
      }
    }

    // --- inlay hints (parameter names, like Rider)
    if (caps.inlayHintProvider) {
      this.inlayEmitter = new monaco.Emitter();
      const resolvable = typeof caps.inlayHintProvider === 'object' && caps.inlayHintProvider.resolveProvider;
      add(L.registerInlayHintsProvider(sel, {
        onDidChangeInlayHints: this.inlayEmitter.event,
        async provideInlayHints(model, range, token) {
          const r = await self.request('textDocument/inlayHint', { textDocument: doc(model), range: cv.toLspRange(range) }, token);
          const hints = (r || []).map((h) => ({
            label: typeof h.label === 'string' ? h.label : h.label.map((p) => ({ label: p.value, tooltip: p.tooltip })),
            position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
            kind: h.kind === 1 ? L.InlayHintKind.Type : h.kind === 2 ? L.InlayHintKind.Parameter : undefined,
            paddingLeft: h.paddingLeft,
            paddingRight: h.paddingRight,
            tooltip: h.tooltip ? cv.markdown(h.tooltip) : undefined,
            __lsp: h,
          }));
          return { hints, dispose() {} };
        },
        resolveInlayHint: resolvable ? async (hint, token) => {
          const r = await self.request('inlayHint/resolve', hint.__lsp, token);
          if (r && r.tooltip) hint.tooltip = cv.markdown(r.tooltip);
          return hint;
        } : undefined,
      }));
    }

    // --- code lens ("N references")
    if (caps.codeLensProvider) {
      this.codeLensEmitter = new monaco.Emitter();
      const resolvable = caps.codeLensProvider.resolveProvider;
      this.codeLensProvider = {
        onDidChange: this.codeLensEmitter.event,
        async provideCodeLenses(model, token) {
          if (!self.codeLensEnabled) return { lenses: [], dispose() {} };
          const r = await self.request('textDocument/codeLens', { textDocument: doc(model) }, token);
          // Rider-style: usage counts on types and methods only, not on every field
          const keep = (l) => {
            const line = model.getLineContent(l.range.start.line + 1);
            return /\b(class|struct|interface|enum|record|delegate)\b/.test(line) || /\(/.test(line.split('=')[0]);
          };
          const lenses = (r || []).filter(keep).map((l) => ({
            range: cv.toRange(l.range),
            command: l.command ? { id: 'papyrus.lsp.command', title: l.command.title, arguments: [l.command] } : undefined,
            __lsp: l,
          }));
          lenses.push(...await self.inheritanceLenses(model, token));
          // Monaco resolves lenses only once their view zones are on screen, which they aren't yet
          // the first time a file is shown: the Roslyn "N references" stayed blank until a scroll.
          // Ask once more right after a file is first shown in the editor.
          const shown = monaco.editor.getEditors().some((e) => e.getModel() === model);
          if (shown && self.lensKickedFor !== model) {
            self.lensKickedFor = model;
            for (const ms of LENS_KICK_MS) setTimeout(() => self.codeLensEmitter && self.codeLensEmitter.fire(self.codeLensProvider), ms);
          }
          return { lenses, dispose() {} };
        },
        resolveCodeLens: resolvable ? async (model, lens, token) => {
          if (!lens.__lsp) return lens; // our inheritance lenses come resolved
          const r = await self.request('codeLens/resolve', lens.__lsp, token);
          if (r && r.command) lens.command = { id: 'papyrus.lsp.command', title: r.command.title, arguments: [r.command, model.uri.toString()] };
          return lens;
        } : undefined,
      };
      add(L.registerCodeLensProvider(sel, this.codeLensProvider));
    }
  }

  // Rider-style "상속 N개" / "구현 N개" / "재정의 N개" lenses on classes, interfaces and on
  // virtual / abstract / interface members. Only symbols that actually have some get a lens,
  // so the counts are fetched here (a handful of requests per file) rather than on resolve.
  async inheritanceLenses(model, token) {
    if (!this.caps || !this.caps.implementationProvider) return [];
    const uri = model.uri.toString();
    const version = model.getVersionId();
    const cached = this.inhCache && this.inhCache.get(uri);
    // inheritors live in other files too, so the per-version cache only spares rapid re-asks
    if (cached && cached.version === version && Date.now() - cached.at < INH_CACHE_MS) return cached.lenses;

    const syms = await this.documentSymbols(model, token).catch(() => []);
    const cands = [];
    const walk = (list, parentIsInterface) => {
      for (const s of list || []) {
        const pos = (s.selectionRange || s.range).start;
        const line = model.getLineContent(pos.line + 1);
        if (s.kind === 5 || s.kind === 11) { // class, interface
          if (s.kind === 11 || !/\b(static|sealed)\b/.test(line)) cands.push({ pos, kind: s.kind === 11 ? 'iface' : 'class' });
        } else if ((s.kind === 6 || s.kind === 7 || s.kind === 24) && (parentIsInterface || /\b(virtual|abstract)\b/.test(line))) {
          cands.push({ pos, kind: parentIsInterface || /\babstract\b/.test(line) ? 'impl' : 'override' });
        }
        walk(s.children, s.kind === 11);
      }
    };
    walk(syms, false);

    const lenses = [];
    await Promise.all(cands.slice(0, 40).map(async (c) => {
      const locs = await this.implementations(uri, c.pos).catch(() => []);
      if (!locs.length || (token && token.isCancellationRequested)) return;
      const n = locs.length;
      // same wording as Roslyn's Korean "참조 N개"
      const title = c.kind === 'class' ? `상속 ${n}개` : c.kind === 'override' ? `재정의 ${n}개` : `구현 ${n}개`;
      lenses.push({
        range: new monaco.Range(c.pos.line + 1, 1, c.pos.line + 1, 1),
        command: { id: 'papyrus.lsp.command', title, arguments: [{ command: 'papyrus.showImplementations', arguments: [uri, c.pos] }, uri] },
      });
    }));
    if (!token || !token.isCancellationRequested) {
      this.inhCache = this.inhCache || new Map();
      this.inhCache.set(uri, { version, lenses, at: Date.now() });
    }
    return lenses;
  }

  async documentSymbols(model, token) {
    if (!this.caps || !this.caps.documentSymbolProvider) return [];
    const r = await this.request('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } }, token);
    if (!r) return [];
    // Flat SymbolInformation[] -> pseudo-tree
    if (r.length && r[0].location) {
      return r.map((s) => ({ name: s.name, kind: s.kind, detail: s.containerName || '', range: s.location.range, selectionRange: s.location.range, children: [] }));
    }
    return r;
  }

  async workspaceSymbols(query, token) {
    if (!this.caps || !this.caps.workspaceSymbolProvider) return [];
    const r = await this.request('workspace/symbol', { query }, token);
    return r || [];
  }

  async references(model, position) {
    const r = await this.request('textDocument/references', {
      textDocument: { uri: model.uri.toString() },
      position: cv.toPos(position),
      context: { includeDeclaration: false },
    });
    return r || [];
  }

  // Derived types / implementations / overrides of the symbol at an LSP position, as plain
  // {uri, range} locations, without the symbol's own declaration.
  async implementations(uri, lspPos) {
    if (!this.caps || !this.caps.implementationProvider) return [];
    const r = await this.request('textDocument/implementation', { textDocument: { uri }, position: lspPos });
    const list = (Array.isArray(r) ? r : r ? [r] : []).map((l) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange || l.targetRange } : l));
    const self = normUri(uri);
    return list.filter((l) => !(normUri(l.uri) === self && l.range.start.line <= lspPos.line && l.range.end.line >= lspPos.line));
  }

  async definitionAt(model, position) {
    if (!this.caps || !this.caps.definitionProvider) return [];
    const r = await this.request('textDocument/definition', { textDocument: { uri: model.uri.toString() }, position: cv.toPos(position) });
    return (Array.isArray(r) ? r : r ? [r] : []).map((l) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange || l.targetRange } : l));
  }

  // Converts an LSP WorkspaceEdit to Monaco's. Edits for files that aren't loaded as models are
  // written to disk directly (via onApplyEdit) because Monaco can only edit models it knows.
  toMonacoEdit(we) {
    const out = [];
    const closed = { changes: {} };
    let hasClosed = false;
    const push = (uri, edits) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model && (!this.isEditableModel || this.isEditableModel(model))) {
        for (const e of edits) out.push({ resource: model.uri, textEdit: { range: cv.toRange(e.range), text: e.newText }, versionId: undefined });
      } else {
        closed.changes[uri] = (closed.changes[uri] || []).concat(edits);
        hasClosed = true;
      }
    };
    if (we.documentChanges) {
      for (const dc of we.documentChanges) {
        if (dc.textDocument) push(dc.textDocument.uri, dc.edits);
        else if (dc.kind) {
          closed.documentChanges = closed.documentChanges || [];
          closed.documentChanges.push(dc);
          hasClosed = true;
        }
      }
    } else if (we.changes) {
      for (const [uri, edits] of Object.entries(we.changes)) push(uri, edits);
    }
    if (hasClosed) this.onApplyEdit && this.onApplyEdit(closed, { closedOnly: true });
    return { edits: out };
  }

  async ensureModels(uris) {
    if (this.ensureModelHook) await this.ensureModelHook(uris);
  }
}

function normUri(u) {
  return monaco.Uri.parse(u).toString();
}

function toLocations(r) {
  if (!r) return [];
  const arr = Array.isArray(r) ? r : [r];
  return arr.map((l) => (l.targetUri
    ? { uri: monaco.Uri.parse(l.targetUri), range: cv.toRange(l.targetSelectionRange || l.targetRange) }
    : { uri: monaco.Uri.parse(l.uri), range: cv.toRange(l.range) }));
}

function convertCompletion(it, defaults, fallback, model) {
  const L = monaco.languages;
  let range = fallback;
  let text = it.insertText != null ? it.insertText : it.label;
  const te = it.textEdit || (defaults.editRange ? { ...(defaults.editRange.insert ? defaults.editRange : { range: defaults.editRange }), newText: it.textEditText != null ? it.textEditText : text } : null);
  if (te) {
    text = te.newText;
    range = te.range ? cv.toRange(te.range) : { insert: cv.toRange(te.insert), replace: cv.toRange(te.replace) };
  }
  // Monaco requires single-line ranges that contain the cursor line
  let fmt = it.insertTextFormat != null ? it.insertTextFormat : defaults.insertTextFormat;
  let commit = it.commitCharacters || defaults.commitCharacters;
  if (commit) commit = commit.filter((c) => c !== ' ');
  // Methods complete with "()" and the caret between them (Rider), "new Foo" too
  let command = it.command ? { id: 'papyrus.lsp.command', title: it.command.title || '', arguments: [it.command, model.uri.toString()] } : undefined;
  const bare = /^@?\w+<>$/.test(text) ? text.slice(0, -2) : text; // "GetComponent<>" labels
  const call = !command && fmt !== 2 && /^@?\w+$/.test(bare) && callParens(it, model, fallback);
  if (call) {
    text = bare;
    text = call.generic ? `${text}<$1>($0)` : `${text}($0)`;
    fmt = 2;
    if (commit) commit = commit.filter((c) => c !== '(' && c !== '<');
    command = { id: 'editor.action.triggerParameterHints', title: '' };
  }
  const s = {
    label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
    kind: cv.completionKind(it.kind),
    detail: it.detail,
    documentation: cv.markdown(it.documentation) || undefined,
    // Unity's inspector attributes (SerializeField, Header...) rank first, see unity-completions.js
    __unityAttr: UNITY_ATTRIBUTE_NAMES.has(it.label),
    sortText: it.sortText,
    filterText: it.filterText,
    preselect: it.preselect,
    insertText: text,
    insertTextRules: fmt === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : L.CompletionItemInsertTextRule.None,
    range,
    commitCharacters: commit,
    tags: it.deprecated || (it.tags && it.tags.includes(1)) ? [L.CompletionItemTag.Deprecated] : undefined,
    additionalTextEdits: it.additionalTextEdits ? it.additionalTextEdits.map((e) => ({ range: cv.toRange(e.range), text: e.newText })) : undefined,
    command,
    __lsp: { ...it, data: it.data !== undefined ? it.data : defaults.data },
  };
  return s;
}

/**
 * Whether a completion should insert "()" (and "<>" for generic methods like GetComponent<>):
 * methods/functions, and types right after `new`. Not when parentheses already follow, nor where
 * a method group is meant (nameof(...), += / -= handlers, AddListener(...)).
 */
function callParens(it, model, wordRange) {
  const line = model.getLineContent(wordRange.startLineNumber);
  const before = line.slice(0, wordRange.startColumn - 1);
  const after = line.slice(wordRange.endColumn - 1).replace(/^\w*/, ''); // rest of the word under the caret
  if (/^\s*[(<]/.test(after)) return null;
  if (/\b(?:override|partial)\s+(?:[\w<>[\],.?]+\s+)*$/.test(before)) return null; // declaring, not calling
  const method = it.kind === 2 || it.kind === 3; // Method, Function (extension methods are Method too)
  const newType = (it.kind === 7 || it.kind === 22) && /\bnew\s+$/.test(before); // Class, Struct
  if (!method && !newType) return null;
  if (method && /(\bnameof\s*\(\s*|[+-]=\s*|\b(?:Add|Remove)Listener\s*\(\s*|\b(?:Start|Stop)Coroutine\s*\(\s*nameof\s*\(\s*)$/.test(before)) return null;
  return { generic: /<>$/.test(it.label) || (it.labelDetails && /^<>/.test(it.labelDetails.detail || '')) };
}
