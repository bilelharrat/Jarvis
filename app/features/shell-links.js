// jarvis:// links, and the Services menu's "Ask JARVIS" that sends a selection to one. Pure
// (app/features/shell.js opens the links and writes the Quick Action on the owner's click).
//
// Any web page or app can open a jarvis:// link, so a link only ever shows JARVIS: it fills
// in the request box (never sends it: the owner presses Return), opens a panel, or opens a
// Jarvis Code project. Everything in one is checked and capped here.
'use strict';

const PANELS = ['settings', 'code', 'browser', 'brain'];
const ASK_MAX = 2000; // characters a link can put in the request box
const LINK_MAX = 40_000; // characters of the link itself (2,000 Chinese characters, encoded)

// One line of plain text: line breaks become spaces, and controls, direction overrides and
// invisible characters that could hide or reorder words in the box are dropped (joiners that
// emoji and some scripts need stay).
function cleanText(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// {action: 'ask', text} | {action: 'open', panel} | {action: 'code', project}, or null for
// anything else (another scheme, an unknown action or panel, a project name with a path in it).
function parseLink(raw) {
  if (typeof raw !== 'string' || raw.length > LINK_MAX) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'jarvis:' || url.username || url.password || url.port) return null;
  const action = (url.hostname || url.pathname.replace(/^\/+|\/+$/g, '')).toLowerCase();
  const params = url.searchParams;
  if (action === 'ask') {
    return { action: 'ask', text: Array.from(cleanText(params.get('text') || '')).slice(0, ASK_MAX).join('') };
  }
  if (action === 'open') {
    const panel = String(params.get('panel') || '').toLowerCase();
    return !panel || PANELS.includes(panel) ? { action: 'open', panel } : null;
  }
  if (action === 'code') {
    const project = cleanText(params.get('project') || '');
    if (!project || project.length > 100 || /[/\\]/.test(project) || project.startsWith('.')) return null;
    return { action: 'code', project };
  }
  return null;
}

// ── the Services menu's "Ask JARVIS": an Automator Quick Action in ~/Library/Services ──

const SERVICE_NAME = 'Ask JARVIS';
const SERVICE_BUNDLE = `${SERVICE_NAME}.workflow`;
const SERVICE_ID = 'com.bshventures.jarvis.ask-service'; // what marks the Quick Action as ours

// Its one step, a shell script as Apple's own "Show Map" Quick Action has: the selection
// comes in on stdin, JavaScript for Automation URL-encodes it (as UTF-8, whatever the
// language), and macOS opens the link. The text never passes through the shell.
const SERVICE_SCRIPT = [
  '# Ask J.A.R.V.I.S. about the selected text: it opens in the request box, and nothing',
  '# is sent until you press Return there.',
  "url=$(/usr/bin/osascript -l JavaScript -e 'ObjC.import(\"Foundation\");",
  'const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;',
  'const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || "";',
  `"jarvis://ask?text=" + encodeURIComponent(Array.from(text.trim()).slice(0, ${ASK_MAX}).join(""))')`,
  '[ -n "$url" ] && /usr/bin/open "$url"',
].join('\n');

// ── property lists, written the way Xcode and Automator write them ──

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistValue(value, depth) {
  const tab = '\t'.repeat(depth);
  if (value === true) return `${tab}<true/>`;
  if (value === false) return `${tab}<false/>`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${tab}<integer>${value}</integer>` : `${tab}<real>${value}</real>`;
  if (typeof value === 'string') return `${tab}<string>${xml(value)}</string>`;
  if (Array.isArray(value)) {
    if (!value.length) return `${tab}<array/>`;
    return [`${tab}<array>`, ...value.map((v) => plistValue(v, depth + 1)), `${tab}</array>`].join('\n');
  }
  const keys = Object.keys(value);
  if (!keys.length) return `${tab}<dict/>`;
  const lines = [`${tab}<dict>`];
  for (const key of keys) lines.push(`${tab}\t<key>${xml(key)}</key>`, plistValue(value[key], depth + 1));
  lines.push(`${tab}</dict>`);
  return lines.join('\n');
}

function plist(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value, 0),
    '</plist>',
    '',
  ].join('\n');
}

// The bundle's two files, by their path inside it. Always the same bytes: the tests keep a
// copy (tests/web/fixtures/) to compare with.
function serviceFiles() {
  const info = {
    CFBundleDevelopmentRegion: 'en_US',
    CFBundleIdentifier: SERVICE_ID,
    CFBundleName: SERVICE_NAME,
    CFBundleShortVersionString: '1.0',
    NSServices: [{
      NSBackgroundColorName: 'background',
      NSIconName: 'NSActionTemplate',
      NSMenuItem: { default: SERVICE_NAME },
      NSMessage: 'runWorkflowAsService',
      NSRequiredContext: {}, // a service with one is on in the Services menu from the start
      NSSendTypes: ['public.utf8-plain-text'],
    }],
  };
  const parameter = (name, value, uuid) => ({ 'default value': value, name, required: '0', type: '0', uuid: String(uuid) });
  const document = {
    AMApplicationBuild: '540',
    AMApplicationVersion: '2.10',
    AMDocumentVersion: '2',
    actions: [{
      action: {
        AMAccepts: { Container: 'List', Optional: true, Types: ['com.apple.cocoa.string'] },
        AMActionVersion: '2.0.3',
        AMApplication: ['Automator'],
        AMParameterProperties: { COMMAND_STRING: {}, CheckedForUserDefaultShell: {}, inputMethod: {}, shell: {}, source: {} },
        AMProvides: { Container: 'List', Types: ['com.apple.cocoa.string'] },
        ActionBundlePath: '/System/Library/Automator/Run Shell Script.action',
        ActionName: 'Run Shell Script',
        ActionParameters: {
          COMMAND_STRING: SERVICE_SCRIPT,
          CheckedForUserDefaultShell: true,
          inputMethod: 0, // the selection on stdin
          shell: '/bin/zsh',
          source: '',
        },
        BundleIdentifier: 'com.apple.RunShellScript',
        CFBundleVersion: '2.0.3',
        CanShowSelectedItemsWhenRun: false,
        CanShowWhenRun: true,
        Category: ['AMCategoryUtilities'],
        'Class Name': 'RunShellScriptAction',
        InputUUID: '5A0E2C7B-0B1F-4E0E-9C39-2C1F4D8E3A11',
        Keywords: ['Shell', 'Script', 'Command', 'Run', 'Unix'],
        OutputUUID: '9D3B6F14-7C2A-4B8E-A5D1-6E0F2B9C4D22',
        UUID: 'C81F0A5E-3D6B-4F27-8E9A-1B4C7D2E5F33',
        UnlocalizedApplications: ['Automator'],
        arguments: {
          0: parameter('inputMethod', 0, 0),
          1: parameter('CheckedForUserDefaultShell', false, 1),
          2: parameter('source', '', 2),
          3: parameter('COMMAND_STRING', '', 3),
          4: parameter('shell', '/bin/sh', 4),
        },
        isViewVisible: true,
        location: '309.500000:631.000000',
        nibPath: '/System/Library/Automator/Run Shell Script.action/Contents/Resources/en.lproj/main.nib',
      },
      isViewVisible: true,
    }],
    connectors: {},
    workflowMetaData: {
      applicationBundleIDsByPath: {},
      applicationPaths: [],
      inputTypeIdentifier: 'com.apple.Automator.text',
      outputTypeIdentifier: 'com.apple.Automator.nothing',
      presentationMode: 11,
      processesInput: false,
      serviceInputTypeIdentifier: 'com.apple.Automator.text',
      serviceOutputTypeIdentifier: 'com.apple.Automator.nothing',
      serviceProcessesInput: false,
      systemImageName: 'NSActionTemplate',
      useAutomaticInputType: false,
      workflowTypeIdentifier: 'com.apple.Automator.servicesMenu',
    },
  };
  return { 'Contents/Info.plist': plist(info), 'Contents/document.wflow': plist(document) };
}

// Is the Info.plist given (its text) one this app wrote? Only ours is ever replaced or removed.
const isOurService = (infoText) => typeof infoText === 'string' && infoText.includes(`<string>${SERVICE_ID}</string>`);

module.exports = { PANELS, ASK_MAX, cleanText, parseLink, SERVICE_NAME, SERVICE_BUNDLE, SERVICE_ID, SERVICE_SCRIPT, plist, serviceFiles, isOurService };
