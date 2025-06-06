/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import { TestModelCollection } from './testModel';
import type { TestModel, TestProject } from './testModel';
import { createGuid, normalizePath, uriToPath } from './utils';
import * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import * as upstream from './upstream/testTree';
import { TeleSuite } from './upstream/teleReceiver';
import { DisposableBase } from './disposableBase';

/**
 * This class maps a collection of TestModels into the UI terms, it merges
 * multiple logical entities (for example, one per project) into a single UI entity
 * that can be executed at once.
 */
export class TestTree extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;

  // We don't want tests to persist state between sessions, so we are using unique test id prefixes.
  private _testGeneration = '';

  // Global test item map location => fileItem that are files.
  private _rootItems = new Map<string, vscodeTypes.TestItem>();

  private _testController: vscodeTypes.TestController;
  private _models: TestModelCollection;
  private _loadingItem: vscodeTypes.TestItem;
  private _testItemByTestId = new Map<string, vscodeTypes.TestItem>();
  private _testItemByFile = new Map<string, vscodeTypes.TestItem>();

  constructor(vscode: vscodeTypes.VSCode, models: TestModelCollection, testController: vscodeTypes.TestController) {
    super();
    this._vscode = vscode;
    this._models = models;
    this._testController = testController;
    this._loadingItem = this._testController.createTestItem('loading', 'Loading\u2026');
    this._disposables = [
      models.onUpdated(() => this._update()),
    ];
  }

  startedLoading() {
    this._testGeneration = createGuid() + ':';
    this._testController.items.replace([]);
    this._rootItems.clear();
    this._testItemByTestId.clear();
    this._testItemByFile.clear();

    if (!this._vscode.workspace.workspaceFolders?.length)
      return;

    this._testController.items.replace([this._loadingItem]);
  }

  finishedLoading() {
    if (this._loadingItem.parent)
      this._loadingItem.parent.children.delete(this._loadingItem.id);
    else if (this._testController.items.get(this._loadingItem.id))
      this._testController.items.delete(this._loadingItem.id);
  }

  collectTestsInside(rootItem: vscodeTypes.TestItem): vscodeTypes.TestItem[] {
    const result: vscodeTypes.TestItem[] = [];
    const visitItem = (testItem: vscodeTypes.TestItem) => {
      const treeItem = (testItem as any)[testTreeItemSymbol] as upstream.TreeItem | undefined;
      if (!testItem)
        return;
      if ((treeItem?.kind === 'case' || treeItem?.kind === 'test') && treeItem.test)
        result.push(testItem);
      else
        testItem.children.forEach(visitItem);
    };
    visitItem(rootItem);
    return result;
  }

  private _update() {
    for (const workspaceFolder of this._vscode.workspace.workspaceFolders ?? []) {
      const disabledProjects: TestProject[] = [];
      const configErrorsByModel = new Map<TestModel, reporterTypes.TestError[]>();
      const workspaceFSPath = uriToPath(workspaceFolder.uri);
      const rootSuite = new TeleSuite('', 'root');
      for (const model of this._models.enabledModels().filter(m => m.config.workspaceFolder === workspaceFSPath)) {
        const configErrors = model.configErrors();
        if (configErrors.length)
          configErrorsByModel.set(model, configErrors);

        for (const project of model.projects()) {
          if (project.isEnabled)
            rootSuite.suites.push(project.suite as TeleSuite);
          else
            disabledProjects.push(project);
        }
      }

      const upstreamTree = new upstream.TestTree(workspaceFSPath, rootSuite, [], undefined, path.sep);
      upstreamTree.sortAndPropagateStatus();
      upstreamTree.flattenForSingleProject();

      if (upstreamTree.rootItem.children.length === 0 && !disabledProjects.length && configErrorsByModel.size === 0) {
        this._deleteRootItem(workspaceFSPath);
        continue;
      }

      const workspaceRootItem = this._createRootItemIfNeeded(workspaceFolder.uri);
      this._syncSuite(upstreamTree.rootItem, workspaceRootItem);
      this._syncDisabledProjects(workspaceRootItem, disabledProjects);
      this._syncConfigErrors(workspaceRootItem, configErrorsByModel);
    }

    // Remove stale root items.
    for (const itemFsPath of this._rootItems.keys()) {
      if (!this._vscode.workspace.workspaceFolders!.find(f => uriToPath(f.uri) === itemFsPath))
        this._deleteRootItem(itemFsPath);
    }
    this._indexTree();
  }

  private _syncSuite(uItem: upstream.TreeItem, vsItem: vscodeTypes.TestItem) {
    const uChildren = uItem.children;
    const vsChildren = vsItem.children;
    const uChildrenById = new Map(uChildren.map(c => [c.id, c]));
    const vsChildrenById = new Map<string, vscodeTypes.TestItem>();
    vsChildren.forEach(c => {
      if (c.id.startsWith(this._testGeneration))
        vsChildrenById.set(c.id.substring(this._testGeneration.length), c);
    });

    // Remove deleted children.
    for (const id of vsChildrenById.keys()) {
      if (!uChildrenById.has(id)) {
        vsChildren.delete(this._idWithGeneration(id));
        vsChildrenById.delete(id);
      }
    }

    // Add new children.
    for (const [id, uChild] of uChildrenById) {
      let vsChild = vsChildrenById.get(id);
      if (!vsChild) {
        vsChild = this._testController.createTestItem(this._idWithGeneration(id), uChild.title, this._vscode.Uri.file(uChild.location.file));
        // Allow lazy-populating file items created via listFiles.
        if (uChild.kind === 'group' && uChild.subKind === 'file' && !uChild.children.length)
          vsChild.canResolveChildren = true;
        vsChildrenById.set(id, vsChild);
        vsChildren.add(vsChild);
      }
      (vsChild as any)[testTreeItemSymbol] = uChild;
      if (uChild.kind === 'case' && !areEqualTags(uChild.tags, vsChild.tags))
        vsChild.tags = uChild.tags.map(tag => new this._vscode.TestTag(tag));
      const hasLocation = uChild.location.line || uChild.location.column;
      if (hasLocation && (!vsChild.range || vsChild.range.start.line + 1 !== uChild.location.line)) {
        const line = uChild.location.line;
        vsChild.range = new this._vscode.Range(Math.max(line - 1, 0), 0, line, 0);
      } else if (hasLocation && !vsChild.range) {
        vsChild.range = undefined;
      }
    }

    // Sync children.
    for (const [id, uChild] of uChildrenById) {
      const vsChild = vsChildrenById.get(id);
      this._syncSuite(uChild, vsChild!);
    }
  }

  private _syncDisabledProjects(workspaceRootItem: vscodeTypes.TestItem, disabledProjects: TestProject[]) {
    const topLevelItems: string[] = [];
    workspaceRootItem.children.forEach(item => topLevelItems.push(item.id));
    const oldDisabledProjectIds = new Set(topLevelItems.filter(item => item.startsWith('[disabled] ')));
    const sortedProject = disabledProjects.sort((a, b) => {
      const keyA = a.model.config.configFile + ':' + a.name;
      const keyB = b.model.config.configFile + ':' + b.name;
      return keyA.localeCompare(keyB);
    });
    for (const project of sortedProject) {
      const config = project.model.config;
      const projectId = '[disabled] ' + project.name + ' - ' + config.configFile;
      if (oldDisabledProjectIds.has(projectId)) {
        oldDisabledProjectIds.delete(projectId);
        continue;
      }

      const item = this._testController.createTestItem(projectId, '');
      item.description = `${path.relative(config.workspaceFolder, normalizePath(config.configFile))} [${project.name}] — disabled`;
      item.sortText = 'z' + project.name;
      (item as any)[disabledProjectSymbol] = project;
      workspaceRootItem.children.add(item);
    }
    for (const projectId of oldDisabledProjectIds)
      workspaceRootItem.children.delete(projectId);
  }

  private _syncConfigErrors(workspaceRootItem: vscodeTypes.TestItem, errorsByModel: Map<TestModel, reporterTypes.TestError[]>) {
    const topLevelItems: string[] = [];
    workspaceRootItem.children.forEach(item => topLevelItems.push(item.id));
    const oldErrorIds = new Set(topLevelItems.filter(item => item.startsWith('[error] ')));
    for (const [model, errors] of errorsByModel) {
      for (const error of errors) {
        const message = error.message ?? error.value ?? 'Unknown error';
        const location = error.location ? `${error.location.file}:${error.location.line}` : model.config.configFile;
        const errorId = `[error] ${location} - ${message}`;
        if (oldErrorIds.has(errorId)) {
          oldErrorIds.delete(errorId);
          continue;
        }

        const item = this._testController.createTestItem(errorId, '', this._vscode.Uri.file(error.location?.file ?? model.config.configFile));
        item.error = message;
        item.description = `${path.relative(model.config.workspaceFolder, normalizePath(model.config.configFile))} — ${message}`;
        item.sortText = 'z' + errorId;
        if (error.location) {
          const position = new this._vscode.Position(error.location.line - 1, error.location.column - 1);
          item.range = new this._vscode.Range(position, position);
        }
        (item as any)[configErrorSymbol] = error;
        workspaceRootItem.children.add(item);
      }
    }
    for (const itemId of oldErrorIds)
      workspaceRootItem.children.delete(itemId);
  }

  private _indexTree() {
    this._testItemByTestId.clear();
    this._testItemByFile.clear();
    const visit = (item: vscodeTypes.TestItem) => {
      const treeItem = (item as any)[testTreeItemSymbol] as upstream.TreeItem | undefined;
      if ((treeItem?.kind === 'case' || treeItem?.kind === 'test') && treeItem.test)
        this._testItemByTestId.set(treeItem.test.id, item);
      for (const [, child] of item.children)
        visit(child);
      if (item.uri && !item.range)
        this._testItemByFile.set(uriToPath(item.uri), item);
    };
    for (const item of this._rootItems.values())
      visit(item);
  }

  private _createRootItemIfNeeded(uri: vscodeTypes.Uri): vscodeTypes.TestItem {
    const fsPath = uriToPath(uri);
    if (this._rootItems.has(fsPath))
      return this._rootItems.get(fsPath)!;
    let item: vscodeTypes.TestItem;
    if (this._vscode.workspace.workspaceFolders!.length === 1) {
      item = {
        id: this._idWithGeneration(fsPath),
        uri: uri,
        children: this._testController.items,
        parent: undefined,
        tags: [],
        canResolveChildren: false,
        busy: false,
        label: '<root>',
        range: undefined,
        error: undefined,
      };
    } else {
      item = this._testController.createTestItem(this._idWithGeneration(fsPath), path.basename(fsPath), uri);
      this._testController.items.add(item);
    }
    this._rootItems.set(fsPath, item);
    return item;
  }

  private _deleteRootItem(fsPath: string): void {
    if (this._vscode.workspace.workspaceFolders!.length === 1) {
      const items: vscodeTypes.TestItem[] = [];
      this._testController.items.forEach(item => items.push(item));
      this._testController.items.replace(items.filter(i => i.id === 'loading' || i.id === 'disabled'));
    } else {
      this._testController.items.delete(this._idWithGeneration(fsPath));
    }
    this._rootItems.delete(fsPath);
  }

  testItemForTest(test: reporterTypes.TestCase): vscodeTypes.TestItem | undefined {
    return this._testItemByTestId.get(test.id);
  }

  testItemForFile(file: string): vscodeTypes.TestItem | undefined {
    return this._testItemByFile.get(file);
  }

  private _idWithGeneration(id: string): string {
    return this._testGeneration + id;
  }
}

function areEqualTags(uTags: readonly string[], vsTags: readonly vscodeTypes.TestTag[]): boolean {
  if (uTags.length !== vsTags.length)
    return false;
  const uTagsSet = new Set(uTags);
  for (const tag of vsTags) {
    if (!uTagsSet.has(tag.id))
      return false;
  }
  return true;
}

export function upstreamTreeItem(treeItem: vscodeTypes.TreeItem): upstream.TreeItem {
  return (treeItem as any)[testTreeItemSymbol] as upstream.TreeItem;
}

export function disabledProjectName(item: vscodeTypes.TestItem): TestProject | undefined {
  return (item as any)[disabledProjectSymbol];
}

export function configError(item: vscodeTypes.TestItem): reporterTypes.TestError | undefined {
  return (item as any)[configErrorSymbol];
}

const testTreeItemSymbol = Symbol('testTreeItemSymbol');
const disabledProjectSymbol = Symbol('disabledProjectSymbol');
const configErrorSymbol = Symbol('configErrorSymbol');
