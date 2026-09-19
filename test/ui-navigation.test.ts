import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderAppHtml } from "../src/http/ui.js";

test("the primary navigation puts Files below Characters and keeps Usage under Manage", () => {
  const { document } = parseHTML(renderAppHtml());
  const navigation = [...document.querySelectorAll(".nav-segmented > button")];
  assert.deepEqual(navigation.map((button) => button.id), [
    "normalBtn", "scheduleBtn", "charactersBtn", "workspaceFilesBtn",
    "managementBtn", "settingsBtn", "debugBtn",
  ]);
  assert.equal(document.querySelector("#workspaceFilesBtn span")?.textContent, "文件");
  assert.equal(document.querySelector("#workspaceFilesPage")?.parentElement?.id, "mainPane");
  assert.equal(document.querySelector("#workspaceFilesPanel")?.closest(".settings-page")?.id, "workspaceFilesPage");
  assert.equal(document.querySelector("#usageTabBtn")?.closest(".settings-page")?.id, "managementPage");
  assert.equal(document.querySelector("#usagePanel")?.closest(".settings-page")?.id, "managementPage");
  assert.equal(document.querySelector("#managementPage #workspaceFilesPanel"), null);
  assert.equal(document.querySelector("#workspaceFilesTabBtn, #usageBtn, #usagePage"), null);
});

test("moving Files and Usage preserves a single copy of their controls", () => {
  const html = renderAppHtml();
  const { document } = parseHTML(html);
  for (const id of [
    "workspaceFilesBtn", "workspaceFilesPage", "workspaceFilesPanel",
    "workspaceFileUploadInput", "workspaceFileList", "workspaceFilePreviewDialog",
    "usageTabBtn", "usagePanel", "usageBudgetSaveBtn", "usagePriceSaveBtn",
  ]) assert.equal(document.querySelectorAll("#" + id).length, 1, id);
  assert.doesNotMatch(html, /nodes\.(?:workspaceFilesTabBtn|usageBtn|usagePage)\b/);
});
