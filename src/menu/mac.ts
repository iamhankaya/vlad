import { checkMenuCtx } from "./win.js";
import type { MenuCtx } from "./index.js";

type Mc = Pick<MenuCtx, "node" | "cli" | "home" | "peer" | "self">;
export const macName = (peer: string): string => `${peer} makinesine gönder`;
const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

/** Finder Hızlı Eylemi (Servis): seçili dosya/klasörler `vlad send ... --notify` ile gider. Yollar tam, değerler kabukta tek tırnaklı. */
export function macQuickAction(c: Mc): { dir: string; files: { rel: string; content: string }[] } {
  checkMenuCtx(c, false); // Mac yolunda " olabilir: kabukta tek tırnakla, XML'de kaçışla taşınır
  const name = macName(c.peer);
  const script = `export VLAD_HOME=${sh(c.home)}\n${c.self ? `export VLAD_MACHINE=${sh(c.self)}\n` : ""}${sh(c.node)} ${sh(c.cli)} send --to ${sh(c.peer)} --notify -- "$@"\n`;
  const info = `${HEAD}<plist version="1.0">
<dict>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSBackgroundColorName</key>
\t\t\t<string>background</string>
\t\t\t<key>NSIconName</key>
\t\t\t<string>NSActionTemplate</string>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict>
\t\t\t\t<key>default</key>
\t\t\t\t<string>${xml(name)}</string>
\t\t\t</dict>
\t\t\t<key>NSMessage</key>
\t\t\t<string>runWorkflowAsService</string>
\t\t\t<key>NSRequiredContext</key>
\t\t\t<dict>
\t\t\t\t<key>NSApplicationIdentifier</key>
\t\t\t\t<string>com.apple.finder</string>
\t\t\t</dict>
\t\t\t<key>NSSendFileTypes</key>
\t\t\t<array>
\t\t\t\t<string>public.item</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
  const wflow = `${HEAD}<plist version="1.0">
<dict>
\t<key>AMApplicationBuild</key>
\t<string>523</string>
\t<key>AMApplicationVersion</key>
\t<string>2.10</string>
\t<key>AMDocumentVersion</key>
\t<string>2</string>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Optional</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>AMActionVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>AMApplication</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>AMProvides</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>ActionBundlePath</key>
\t\t\t\t<string>/System/Library/Automator/Run Shell Script.action</string>
\t\t\t\t<key>ActionName</key>
\t\t\t\t<string>Run Shell Script</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<string>${xml(script)}</string>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<integer>1</integer>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<string>/bin/zsh</string>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<string></string>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>CFBundleVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>CanShowSelectedItemsWhenRun</key>
\t\t\t\t<false/>
\t\t\t\t<key>CanShowWhenRun</key>
\t\t\t\t<true/>
\t\t\t\t<key>Category</key>
\t\t\t\t<array>
\t\t\t\t\t<string>AMCategoryUtilities</string>
\t\t\t\t</array>
\t\t\t\t<key>Class Name</key>
\t\t\t\t<string>RunShellScriptAction</string>
\t\t\t\t<key>UnlocalizedApplications</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>arguments</key>
\t\t\t\t<dict/>
\t\t\t\t<key>isViewVisible</key>
\t\t\t\t<integer>1</integer>
\t\t\t</dict>
\t\t\t<key>isViewVisible</key>
\t\t\t<true/>
\t\t</dict>
\t</array>
\t<key>connectors</key>
\t<dict/>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>applicationBundleIDsByPath</key>
\t\t<dict/>
\t\t<key>applicationPaths</key>
\t\t<array/>
\t\t<key>inputTypeIdentifier</key>
\t\t<string>com.apple.Automator.fileSystemObject</string>
\t\t<key>outputTypeIdentifier</key>
\t\t<string>com.apple.Automator.nothing</string>
\t\t<key>presentationMode</key>
\t\t<integer>15</integer>
\t\t<key>processesInput</key>
\t\t<integer>0</integer>
\t\t<key>serviceInputTypeIdentifier</key>
\t\t<string>com.apple.Automator.fileSystemObject</string>
\t\t<key>serviceOutputTypeIdentifier</key>
\t\t<string>com.apple.Automator.nothing</string>
\t\t<key>serviceProcessesInput</key>
\t\t<integer>0</integer>
\t\t<key>systemImageName</key>
\t\t<string>NSActionTemplate</string>
\t\t<key>useAutomaticInputType</key>
\t\t<integer>0</integer>
\t\t<key>workflowTypeIdentifier</key>
\t\t<string>com.apple.Automator.servicesMenu</string>
\t</dict>
</dict>
</plist>
`;
  return { dir: `${name}.workflow`, files: [{ rel: "Contents/Info.plist", content: info }, { rel: "Contents/document.wflow", content: wflow }] };
}
