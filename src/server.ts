'use strict';

import { code2String, fixWithRules, LintOut, RuleSeverity, lint, makeSeverity, readCurrentRules, DevReplayRule, writeRuleFile } from 'devreplay';
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
	Command,
	DiagnosticTag,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

namespace CommandIds {
	export const applySingleFix: string = 'devreplay.fix';
	export const applyDisableRule: string = 'devreplay.applyDisableRule';
	export const applyDowngradeSeverity: string = 'devreplay.applyDowngradeSeverity';
	export const applyUpgradeSeverity: string = 'devreplay.applyUpgradeSeverity';
}

namespace EditorRuleSeverity {
	// Original DevReplay values
	export const error = 'error';
	export const warn = 'warning';
	export const info = 'information';
	export const hint = 'hint';

	// Added severity override changes
	export const off = 'off';
	export const downgrade = 'downgrade';
	export const upgrade = 'upgrade';
}

type EditorRuleSeverity = 'error' | 'warning' | 'information' |  'hint' | 'off' | 'downgrade' | 'upgrade'


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
				commands: [
					CommandIds.applySingleFix,
					CommandIds.applyDisableRule,
					CommandIds.applyDowngradeSeverity,
					CommandIds.applyUpgradeSeverity],
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
	results.forEach((result) => {
		diagnostics.push(makeDiagnostic(result));
	});
	connection.sendDiagnostics({
		uri: document.uri,
		version: document.version,
		diagnostics
	});
}

function lintFile(doc: TextDocument) {
	const ruleFile = URI.parse(getDevReplayPath()).fsPath;
	const fileName = URI.parse(doc.uri).fsPath;
	if (fileName.endsWith(ruleFile) || fileName.endsWith('.git')) {
		return [];
	}

	return lint([fileName], ruleFile);
}

function makeDiagnostic(result: LintOut): Diagnostic {
	const range: Range = {
		start: {
			line: result.position.start.line - 1,
			character: result.position.start.character - 1},
		end: {
			line: result.position.end.line - 1,
			character: result.position.end.character - 1}
	};
	const message = code2String(result.rule);
	const severity = convertSeverityToDiagnostic(makeSeverity(result.rule.severity));
	const diagnostic = Diagnostic.create(range, message, severity, result.rule.ruleId, 'devreplay');
	if (result.rule.deprecated) {
		diagnostic.tags = [DiagnosticTag.Deprecated];
	} else if (result.rule.unnecessary) {
		diagnostic.tags = [DiagnosticTag.Unnecessary];
	}
	return diagnostic;
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
			const title = makeFixTitle();
			const fixAction = CodeAction.create(
				title,
				createEditByPattern(textDocument, diagnostic.range, targetRule.rule),
				CodeActionKind.QuickFix);
			fixAction.diagnostics = [diagnostic];
			codeActions.push(fixAction);

			const disableTitle = `Disable Rule`;
			const disableInProjectAction = CodeAction.create(
				disableTitle,
				Command.create(disableTitle,
							   CommandIds.applyDisableRule,
							   [targetRule.rule.ruleId]),
				CodeActionKind.QuickFix);
			disableInProjectAction.diagnostics = [diagnostic];
			disableInProjectAction.isPreferred = false;
			codeActions.push(disableInProjectAction);

			const upgradeTitle = `Upgrade Rule Severity`;
			const upgradeInProjectAction = CodeAction.create(
				upgradeTitle,
				Command.create(upgradeTitle,
							   CommandIds.applyUpgradeSeverity,
							   [targetRule.rule.ruleId]),
				CodeActionKind.QuickFix);
			upgradeInProjectAction.diagnostics = [diagnostic];
			upgradeInProjectAction.isPreferred = false;
			codeActions.push(upgradeInProjectAction);

			const downgradeTitle = `Downgrade Rule Severity`;
			const downgradeInProjectAction = CodeAction.create(
				downgradeTitle,
				Command.create(downgradeTitle,
							   CommandIds.applyDowngradeSeverity,
							   [targetRule.rule.ruleId]),
				CodeActionKind.QuickFix);
			downgradeInProjectAction.diagnostics = [diagnostic];
			downgradeInProjectAction.isPreferred = false;
			codeActions.push(downgradeInProjectAction);
		});

		return codeActions;
	});

	connection.onExecuteCommand((params) => {
		if ((params.command !== CommandIds.applyDisableRule && 
			 params.command !== CommandIds.applyUpgradeSeverity && 
			 params.command !== CommandIds.applyDowngradeSeverity) || 
			params.arguments === undefined) {
			return;
		}
		const ruleId = String(params.arguments[0]);
		if (params.command === CommandIds.applyDisableRule) {
			changeRuleSeverity(ruleId, EditorRuleSeverity.off);
		} else if (params.command === CommandIds.applyUpgradeSeverity) {
			changeRuleSeverity(ruleId, EditorRuleSeverity.upgrade);
		} else if (params.command === CommandIds.applyDowngradeSeverity) {
			changeRuleSeverity(ruleId, EditorRuleSeverity.downgrade);
		}
		return;
	});
}

function createEditByPattern(document: TextDocument, range: Range, pattern: DevReplayRule): WorkspaceEdit {
	const textDocumentIdentifier: VersionedTextDocumentIdentifier = {uri: document.uri, version: document.version};
	const newText = fixWithRules(document.getText(range), [pattern]);
	if (newText !== undefined) {
		const edits = [TextEdit.replace(range, newText)];

		return { documentChanges: [TextDocumentEdit.create(textDocumentIdentifier, edits)] };
	}

	return { documentChanges: [] };
}

function makeFixTitle() {
	return 'Fix by DevReplay';
}

function changeRuleSeverity(ruleId: String, editorRuleSeverity: EditorRuleSeverity) {
	if (workspaceFolder === undefined) {
		return;
	}
	const fsPath = URI.parse(workspaceFolder.uri).fsPath;
	let rules = readCurrentRules(fsPath);
	for (let i = 0; i < rules.length; i += 1) {
		if (String(rules[i].ruleId) === ruleId) {
			rules[i].severity = adjustSeverityForOverride(rules[i].severity, editorRuleSeverity);
		}
	}
	writeRuleFile(rules, fsPath, false);
}

function convertSeverityToDiagnostic(severity: RuleSeverity): DiagnosticSeverity {
	switch (severity) {
		case RuleSeverity.error:
			return DiagnosticSeverity.Error;
		case RuleSeverity.warning:
			return DiagnosticSeverity.Warning;
		case RuleSeverity.information:
			return DiagnosticSeverity.Information;
		case RuleSeverity.hint:
			return DiagnosticSeverity.Hint;
		default:
			return DiagnosticSeverity.Warning;
	}
}

function adjustSeverityForOverride(severity: RuleSeverity, severityOverride?: EditorRuleSeverity): RuleSeverity {
	switch (severityOverride) {
		case EditorRuleSeverity.error:
			return RuleSeverity.error;
		case EditorRuleSeverity.warn:
			return RuleSeverity.warning;
		case EditorRuleSeverity.info:
			return RuleSeverity.information;
		case EditorRuleSeverity.hint:
			return RuleSeverity.hint;
		case EditorRuleSeverity.off:
			return RuleSeverity.off;

		case EditorRuleSeverity.downgrade:
			switch (severity) {
				case RuleSeverity.error:
					return RuleSeverity.warning;
				case RuleSeverity.warning:
					return RuleSeverity.information;
				case RuleSeverity.information:
				case RuleSeverity.hint:
					return RuleSeverity.hint;
			}

		case EditorRuleSeverity.upgrade:
			switch (severity) {
				case RuleSeverity.hint:
					return RuleSeverity.information;
				case RuleSeverity.information:
					return RuleSeverity.warning;
				case RuleSeverity.warning:
				case RuleSeverity.error:
					return RuleSeverity.error;
			}

		default:
			return severity;
	}
}

function getDevReplayPath() {
	return path.join(workspaceFolder!.uri, '.devreplay.json');
}

// Listen on the connection
connection.listen();
