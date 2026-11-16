'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const rpc = require('vscode-jsonrpc/node');

const isWin = process.platform === 'win32';

// Roslyn reads these through workspace/configuration. Keys follow vscode-csharp's naming.
const ROSLYN_CONFIG = {
  'csharp|completion.dotnet_show_completion_items_from_unimported_namespaces': true,
  'csharp|completion.dotnet_show_name_completion_suggestions': true,
  'csharp|completion.dotnet_provide_regex_completions': true,
  'csharp|completion.dotnet_trigger_completion_in_argument_lists': true,
  'csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters': true,
  'csharp|inlay_hints.dotnet_enable_inlay_hints_for_literal_parameters': true,
  'csharp|inlay_hints.dotnet_enable_inlay_hints_for_indexer_parameters': false,
  'csharp|inlay_hints.dotnet_enable_inlay_hints_for_object_creation_parameters': true,
  'csharp|inlay_hints.dotnet_enable_inlay_hints_for_other_parameters': false,
  'csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_differ_only_by_suffix': true,
  'csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_method_intent': true,
  'csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_argument_name': true,
  'csharp|inlay_hints.csharp_enable_inlay_hints_for_types': false,
  'csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_variable_types': false,
  'csharp|inlay_hints.csharp_enable_inlay_hints_for_lambda_parameter_types': false,
  'csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_object_creation': false,
  'csharp|code_lens.dotnet_enable_references_code_lens': true,
  'csharp|code_lens.dotnet_enable_tests_code_lens': false,
  'csharp|background_analysis.dotnet_analyzer_diagnostics_scope': 'openFiles',
  'csharp|background_analysis.dotnet_compiler_diagnostics_scope': 'openFiles',
  'csharp|symbol_search.dotnet_search_reference_assemblies': true,
  'csharp|formatting.dotnet_organize_imports_on_format': false,
  'navigation.dotnet_navigate_to_decompiled_sources': true,
  'navigation.dotnet_navigate_to_source_link_and_embedded_sources': true,
  'projects.dotnet_enable_automatic_restore': true,
};

function which(cmd) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext.toLowerCase());
      const P = path.join(dir, cmd + ext);
      if (fs.existsSync(p)) return p;
      if (fs.existsSync(P)) return P;
    }
  }
  return null;
}

function findRoslyn() {
  const name = isWin ? 'roslyn-language-server.exe' : 'roslyn-language-server';
  const toolDir = path.join(os.homedir(), '.dotnet', 'tools');
  const p = path.join(toolDir, name);
  if (fs.existsSync(p)) return p;
  return which('roslyn-language-server');
}

function resolveServer(settings, root) {
  const configured = settings['lsp.path'];
  const extra = Array.isArray(settings['lsp.args']) ? settings['lsp.args'] : [];
  let command = null;
  if (configured && configured !== 'auto') command = configured;
  else command = findRoslyn();
  if (!command) return null;

  const base = path.basename(command).toLowerCase();
  const isOmni = base.includes('omnisharp');
  let args;
  if (isOmni) {
    args = ['-z', '--hostPID', String(process.pid), '--encoding', 'utf-8', '--languageserver', '-s', root,
      'RoslynExtensionsOptions:EnableImportCompletion=true', 'RoslynExtensionsOptions:EnableDecompilationSupport=true',
      'RoslynExtensionsOptions:EnableAnalyzersSupport=true', 'RoslynExtensionsOptions:InlayHintsOptions:EnableForParameters=true',
      'FormattingOptions:EnableEditorConfigSupport=true', 'DotNet:enablePackageRestore=true', ...extra];
  } else if (base.startsWith('roslyn-language-server')) {
    // The dotnet tool wrapper understands --autoLoadProjects.
    args = ['--stdio', '--autoLoadProjects', '--logLevel', 'Information', '--telemetryLevel', 'off', ...extra];
  } else {
    // A raw Microsoft.CodeAnalysis.LanguageServer: we send solution/open ourselves.
    args = ['--stdio', '--logLevel', 'Information', '--telemetryLevel', 'off', ...extra];
  }
  const autoLoad = !isOmni && base.startsWith('roslyn-language-server');
  if (base.endsWith('.dll')) {
    args.unshift(command);
    command = 'dotnet';
  }
  return { command, args, kind: isOmni ? 'omnisharp' : 'roslyn', autoLoad };
}

function run(cmd, args, opts, onLine) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { ...opts, windowsHide: true, shell: false });
    } catch (err) {
      onLine && onLine(String(err));
      resolve(-1);
      return;
    }
    const pipe = (s) => {
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach((l) => onLine && onLine(l));
      });
      s.on('end', () => buf && onLine && onLine(buf));
    };
    pipe(p.stdout);
    pipe(p.stderr);
    p.on('error', (err) => { onLine && onLine(String(err)); resolve(-1); });
    p.on('close', (code) => resolve(code));
  });
}

function solutionIn(root) {
  try {
    const sln = fs.readdirSync(root).filter((f) => f.endsWith('.sln') || f.endsWith('.slnx'));
    return sln.length ? path.join(root, sln[0]) : null;
  } catch {
    return null;
  }
}

function needsRestore(root) {
  let projects = [];
  try {
    projects = fs.readdirSync(root).filter((f) => f.endsWith('.csproj'));
  } catch {
    return false;
  }
  for (const p of projects) {
    const name = p.slice(0, -'.csproj'.length);
    const candidates = [
      path.join(root, 'Temp', 'obj', name, 'project.assets.json'),
      path.join(root, 'obj', name, 'project.assets.json'),
      path.join(root, 'obj', 'project.assets.json'),
    ];
    if (!candidates.some((c) => fs.existsSync(c))) return true;
  }
  return false;
}

class LspServer {
  constructor({ root, settings, logDir, onNotification, onStatus, onLog }) {
    this.root = root;
    this.settings = settings;
    this.logDir = logDir;
    this.onNotification = onNotification;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.proc = null;
    this.conn = null;
    this.tokens = new Map();
    this.capabilities = null;
    this.stopped = false;
    this.kind = null;
    this.restoring = false;
  }

  status(state, detail) {
    this.onStatus({ state, detail: detail || '', kind: this.kind, capabilities: this.capabilities });
  }

  static async restore(root, onLine) {
    const sln = solutionIn(root);
    const target = sln || root;
    onLine(`> dotnet restore "${target}"`);
    const code = await run('dotnet', ['restore', target, '--verbosity', 'minimal'], { cwd: root }, onLine);
    onLine(code === 0 ? '복원 완료' : `복원 실패 (exit ${code})`);
    return code === 0;
  }

  static async installRoslyn(onLine) {
    const dotnet = which('dotnet');
    if (!dotnet) {
      onLine('.NET SDK를 찾을 수 없어요. https://dotnet.microsoft.com/download 에서 .NET 10 SDK를 설치해 주세요.');
      return false;
    }
    onLine('> dotnet tool install --global roslyn-language-server --prerelease');
    let code = await run('dotnet', ['tool', 'install', '--global', 'roslyn-language-server', '--prerelease'], {}, onLine);
    if (code !== 0) {
      onLine('> dotnet tool update --global roslyn-language-server --prerelease');
      code = await run('dotnet', ['tool', 'update', '--global', 'roslyn-language-server', '--prerelease'], {}, onLine);
    }
    onLine(code === 0 ? '설치 완료' : `설치 실패 (exit ${code}). .NET 10 SDK 이상이 필요해요.`);
    return code === 0;
  }

  async start() {
    const server = resolveServer(this.settings, this.root);
    if (!server) {
      this.status('missing', 'roslyn-language-server를 찾을 수 없어요');
      return { ok: false, missing: true };
    }
    this.kind = server.kind;

    if (this.settings['lsp.autoRestore'] !== false && solutionIn(this.root) && needsRestore(this.root)) {
      this.status('restoring', 'dotnet restore');
      this.restoring = true;
      await LspServer.restore(this.root, this.onLog);
      this.restoring = false;
      if (this.stopped) return { ok: false };
    }

    this.status('starting', path.basename(server.command));
    this.onLog(`> ${server.command} ${server.args.join(' ')}`);
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch { /* ignore */ }
    const args = server.kind === 'roslyn' ? [...server.args, '--extensionLogDirectory', this.logDir] : server.args;
    try {
      this.proc = spawn(server.command, args, { cwd: this.root, windowsHide: true, env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en' } });
    } catch (err) {
      this.status('error', String(err.message || err));
      return { ok: false, error: String(err) };
    }
    this.proc.on('error', (err) => {
      this.onLog(`[server error] ${err.message}`);
      this.status('error', err.message);
    });
    this.proc.on('exit', (code) => {
      this.onLog(`[server exited] code=${code}`);
      if (!this.stopped) this.status('error', `언어 서버 종료됨 (code ${code})`);
    });
    let errBuf = '';
    this.proc.stderr.on('data', (d) => {
      errBuf += d.toString();
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop();
      lines.forEach((l) => l && this.onLog(l));
    });

    const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(this.proc.stdout), new rpc.StreamMessageWriter(this.proc.stdin));
    this.conn = conn;
    this.wire(conn);
    conn.listen();

    const rootUri = pathToFileURL(this.root).href;
    try {
      const init = await conn.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'PAPyrus', version: '0.1.0' },
        locale: 'ko',
        rootPath: this.root,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
        capabilities: clientCapabilities(),
        initializationOptions: {},
      });
      this.capabilities = init.capabilities || {};
      conn.sendNotification('initialized', {});
      conn.sendNotification('workspace/didChangeConfiguration', { settings: {} });
      if (this.kind === 'omnisharp') this.status('ready');
      else {
        this.status('loading', '프로젝트 불러오는 중');
        // Older Roslyn builds don't auto-load; tell it which solution to open.
        const sln = solutionIn(this.root);
        if (sln && !server.autoLoad) conn.sendNotification('solution/open', { solution: pathToFileURL(sln).href });
      }
      return { ok: true, capabilities: this.capabilities, kind: this.kind };
    } catch (err) {
      this.status('error', String(err.message || err));
      return { ok: false, error: String(err.message || err) };
    }
  }

  wire(conn) {
    conn.onRequest('workspace/configuration', (params) =>
      (params.items || []).map((it) => {
        const key = it.section || '';
        if (key in ROSLYN_CONFIG) return ROSLYN_CONFIG[key];
        if (key === 'csharp|code_style.formatting.indentation_and_spacing.tab_width') return this.settings['editor.tabSize'] || 4;
        if (key === 'csharp|code_style.formatting.indentation_and_spacing.indent_size') return this.settings['editor.tabSize'] || 4;
        if (key === 'csharp|code_style.formatting.indentation_and_spacing.indent_style') return this.settings['editor.insertSpaces'] === false ? 'tab' : 'space';
        return null;
      }));
    conn.onRequest('client/registerCapability', (params) => {
      this.onNotification('$papyrus/registerCapability', params);
      return null;
    });
    conn.onRequest('client/unregisterCapability', (params) => {
      this.onNotification('$papyrus/unregisterCapability', params);
      return null;
    });
    conn.onRequest('window/workDoneProgress/create', () => null);
    conn.onRequest('window/showMessageRequest', (params) => {
      this.onNotification('window/showMessage', params);
      return null;
    });
    conn.onRequest('window/showDocument', (params) => {
      this.onNotification('$papyrus/showDocument', params);
      return { success: true };
    });
    conn.onRequest('workspace/applyEdit', (params) => {
      this.onNotification('$papyrus/applyEdit', params);
      return { applied: true };
    });
    for (const m of ['workspace/diagnostic/refresh', 'workspace/semanticTokens/refresh', 'workspace/inlayHint/refresh', 'workspace/codeLens/refresh']) {
      conn.onRequest(m, () => {
        this.onNotification(m, {});
        return null;
      });
    }
    conn.onRequest('workspace/_roslyn_projectNeedsRestore', (params) => {
      const projects = (params && params.projectFilePaths) || [];
      this.onLog(`[restore] 복원이 필요한 프로젝트 ${projects.length}개`);
      setTimeout(() => this.roslynRestore(projects), 0);
      return null;
    });
    conn.onNotification('workspace/projectInitializationComplete', () => {
      this.status('ready');
      this.onNotification('workspace/projectInitializationComplete', {});
    });
    conn.onNotification('window/logMessage', (p) => {
      if (p.type <= 2 || this.settings['lsp.verbose']) this.onLog(p.message);
    });
    conn.onNotification('window/showMessage', (p) => this.onNotification('window/showMessage', p));
    conn.onNotification('textDocument/publishDiagnostics', (p) => this.onNotification('textDocument/publishDiagnostics', p));
    conn.onNotification('$/progress', (p) => this.onNotification('$/progress', p));
    conn.onNotification('telemetry/event', () => {});
    conn.onUnhandledNotification((n) => {
      if (n.method.startsWith('$/')) return;
      this.onNotification(n.method, n.params);
    });
    conn.onRequest((method) => {
      this.onLog(`[unhandled server request] ${method}`);
      return null;
    });
    conn.onError(([err]) => this.onLog(`[rpc error] ${err && err.message}`));
    conn.onClose(() => {
      if (!this.stopped) this.status('error', '연결이 끊어졌어요');
    });
  }

  async roslynRestore(projects) {
    if (this.restoring || !this.conn) return;
    this.restoring = true;
    this.status('restoring', 'dotnet restore');
    try {
      await this.conn.sendRequest('workspace/_roslyn_restore', { projectFilePaths: projects });
    } catch (err) {
      this.onLog(`[restore] 서버 복원 실패, dotnet restore로 재시도: ${err.message}`);
      await LspServer.restore(this.root, this.onLog);
    }
    this.restoring = false;
    this.status('ready');
  }

  request(method, params, token) {
    if (!this.conn) return Promise.reject(new Error('not connected'));
    if (token == null) return this.conn.sendRequest(method, params);
    const cts = new rpc.CancellationTokenSource();
    this.tokens.set(token, cts);
    return this.conn.sendRequest(method, params, cts.token).finally(() => this.tokens.delete(token));
  }

  cancel(token) {
    const cts = this.tokens.get(token);
    if (cts) cts.cancel();
  }

  notify(method, params) {
    if (this.conn) this.conn.sendNotification(method, params);
  }

  stop() {
    this.stopped = true;
    const conn = this.conn;
    const proc = this.proc;
    this.conn = null;
    this.proc = null;
    if (conn) {
      conn.sendRequest('shutdown').then(() => conn.sendNotification('exit')).catch(() => {}).finally(() => {
        setTimeout(() => { try { conn.dispose(); } catch { /* ignore */ } }, 200);
      });
    }
    if (proc) setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 1500);
    this.status('stopped');
  }
}

function clientCapabilities() {
  return {
    general: { positionEncodings: ['utf-16'] },
    workspace: {
      applyEdit: true,
      workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] },
      configuration: true,
      workspaceFolders: true,
      symbol: { dynamicRegistration: false, symbolKind: { valueSet: range(1, 26) } },
      diagnostics: { refreshSupport: true },
      semanticTokens: { refreshSupport: true },
      inlayHint: { refreshSupport: true },
      codeLens: { refreshSupport: true },
      didChangeConfiguration: { dynamicRegistration: true },
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: true, willSave: false },
      completion: {
        dynamicRegistration: false,
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: true,
          documentationFormat: ['markdown', 'plaintext'],
          deprecatedSupport: true,
          preselectSupport: true,
          tagSupport: { valueSet: [1] },
          insertReplaceSupport: true,
          labelDetailsSupport: true,
          insertTextModeSupport: { valueSet: [1, 2] },
          resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits', 'command', 'textEdit'] },
        },
        completionItemKind: { valueSet: range(1, 25) },
        completionList: { itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'insertTextMode', 'data'] },
      },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      signatureHelp: {
        signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
        contextSupport: true,
      },
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      implementation: { linkSupport: true },
      references: {},
      documentHighlight: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: range(1, 26) } },
      codeAction: {
        dynamicRegistration: false,
        isPreferredSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ['edit', 'command'] },
        codeActionLiteralSupport: {
          codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] },
        },
      },
      formatting: {},
      rangeFormatting: {},
      onTypeFormatting: {},
      rename: { prepareSupport: true },
      publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, versionSupport: true },
      diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
      foldingRange: { lineFoldingOnly: false },
      selectionRange: {},
      semanticTokens: {
        dynamicRegistration: false,
        requests: { range: true, full: { delta: false } },
        tokenTypes: [],
        tokenModifiers: [],
        formats: ['relative'],
        overlappingTokenSupport: false,
        multilineTokenSupport: true,
        augmentsSyntaxTokens: true,
      },
      inlayHint: { resolveSupport: { properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'] } },
      codeLens: {},
    },
    window: { workDoneProgress: true, showMessage: {}, showDocument: { support: true } },
  };
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

module.exports = { LspServer, resolveServer, findRoslyn };
