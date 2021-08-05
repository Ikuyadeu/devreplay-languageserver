'use strict';

import { code2String, fixWithRules, LintOut, Rule, lint, makeSeverity } from 'devreplay';
import * as path from 'path';
import {
	CodeAction,
	CodeActionKind,
	createConnection,
	Diagnostic,
	DiagnosticSeverity,
	InitializeParams,
	Range,
	TextDocumentEdit,
	TextDocuments,
	TextDocumentSyncKind,
	TextEdit,
	WorkspaceFolder,
	WorkspaceEdit,
	VersionedTextDocumentIdentifier,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection();
connection.console.info(`DevReplay server running in node ${process.version}`);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
documents.listen(connection);

let workspaceFolder: WorkspaceFolder | undefined;

connection.onInitialize((params: InitializeParams, _, progress) => {
	progress.begin('Initializing DevReplay server');

	if (params.workspaceFolders && params.workspaceFolders.length > 0) {
		workspaceFolder = params.workspaceFolders[0];
	}
	const syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Incremental;
	setupDocumentsListeners();

	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: syncKind,
				willSaveWaitUntil: false,
				save: {
					includeText: false
				}
			},
			codeActionProvider: {
				codeActionKinds: [CodeActionKind.QuickFix],
				resolveProvider: true
			},
			executeCommandProvider: {
				commands: ['devreplay.fix'],
			},
		},
	};
});

/**
 * Analyzes the text document for problems.
 * @param document text document to analyze
 */
function validate(document: TextDocument) {
	const diagnostics: Diagnostic[] = [];
	const results = lintFile(document);
	for (let i = 0; i < results.length; i += 1) {
		diagnostics.push(makeDiagnostic(results[i], i));
	}
	connection.sendDiagnostics({
		uri: document.uri,
		version: document.version,
		diagnostics
	});
}

function lintFile(doc: TextDocument) {
	if (workspaceFolder === undefined) {
		return [];
	}
	const ruleFile = URI.parse(`${workspaceFolder.uri}/devreplay.json`).fsPath;
	const fileName = URI.parse(doc.uri).fsPath;
	if (fileName.endsWith(ruleFile) || fileName.endsWith('.git')) {
		return [];
	}

	return lint([fileName], ruleFile);
}

function makeDiagnostic(result: LintOut, code: number): Diagnostic {
	const range: Range = {
		start: {
			line: result.position.start.line - 1,
			character: result.position.start.character - 1},
		end: {
			line: result.position.end.line - 1,
			character: result.position.end.character - 1}
	};
	const message = code2String(result.rule);
	const severity = convertSeverity(makeSeverity(result.rule.severity));
	return Diagnostic.create(range, message, severity, code, 'devreplay');
}

function setupDocumentsListeners() {
	documents.listen(connection);

	documents.onDidOpen((event) => {
		validate(event.document);
	});

	documents.onDidChangeContent((change) => {
		validate(change.document);
	});

	documents.onDidSave((change) => {
		validate(change.document);
	});

	documents.onDidClose((close) => {
		connection.sendDiagnostics({ uri: close.document.uri, diagnostics: []});
	});

	connection.onCodeAction((params) => {
		const diagnostics = params.context.diagnostics.filter((diag) => diag.source === 'devreplay');
		if (diagnostics.length === 0) {
			return [];
		}
		const textDocument = documents.get(params.textDocument.uri);
		if (textDocument === undefined) {
			return [];
		}
		const codeActions: CodeAction[] = [];
		const results = lintFile(textDocument);
		diagnostics.forEach((diagnostic) => {
			const targetRule = results[Number(diagnostic.code)];
			const title = makeFixTitle(targetRule.rule.after);
			const fixAction = CodeAction.create(
				title,
				createEditByPattern(textDocument, diagnostic.range, targetRule.rule),
				CodeActionKind.QuickFix);
			fixAction.diagnostics = [diagnostic];
			codeActions.push(fixAction);
		});

		return codeActions;
	});
}

function createEditByPattern(document: TextDocument, range: Range, pattern: Rule): WorkspaceEdit {
	const textDocumentIdentifier: VersionedTextDocumentIdentifier = {uri: document.uri, version: document.version};
	const newText = fixWithRules(document.getText(range), [pattern]);
	if (newText !== undefined) {
		const edits = [TextEdit.replace(range, newText)];

		return { documentChanges: [TextDocumentEdit.create(textDocumentIdentifier, edits)] };
	}

	return { documentChanges: [] };
}

function convertSeverity(severity: string) {
	switch (severity) {
		case 'E':
			return DiagnosticSeverity.Error;
		case 'W':
			return DiagnosticSeverity.Warning;
		case 'I':
			return DiagnosticSeverity.Information;
		case 'H':
			return DiagnosticSeverity.Hint;
		default:
			return DiagnosticSeverity.Warning;
	}
}

function makeFixTitle(ruleId?: string | string[]) {
	if (ruleId) {
		return `Fix to ${ruleId} by DevReplay`;
	}
	return 'Fix by DevReplay';
}

function disableRule(rule: Rule) {
	// ルールのIDを取得
	const ruleId = rule.ruleId;
	// ルールファイルを開く
	// ルールの場所を特定
	// 該当ルールを消す
	// ルールを保存
}


// Listen on the connection
connection.listen();
