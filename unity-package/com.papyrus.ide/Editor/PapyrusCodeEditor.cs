using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Papyrus.Ide.Editor
{
    /// <summary>
    /// Registers PAPyrus as an External Script Editor (Preferences > External Tools).
    /// </summary>
    [InitializeOnLoad]
    public class PapyrusCodeEditor : IExternalCodeEditor
    {
        internal const string DisplayName = "PAPyrus";

        static readonly HashSet<string> s_SupportedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".cs", ".shader", ".hlsl", ".hlslinc", ".cginc", ".compute", ".glsl", ".raytrace", ".json", ".asmdef", ".asmref",
            ".txt", ".xml", ".uxml", ".uss", ".tss", ".md", ".yaml", ".yml", ".rsp", ".inputactions", ".csproj", ".sln", ".editorconfig"
        };

        readonly ProjectGeneration m_Generator = new ProjectGeneration();
        string m_Installation;

        static PapyrusCodeEditor()
        {
            CodeEditor.Register(new PapyrusCodeEditor());
            EditorApplication.delayCall += AutoSelectOnce;
        }

        // First time the package is loaded on this machine, make PAPyrus the External Script Editor
        // so no trip to Preferences is needed. Done once; the user can switch back any time.
        static void AutoSelectOnce()
        {
            const string key = "Papyrus.Ide.AutoSelected";
            if (EditorPrefs.GetBool(key, false))
                return;
            if (IsCurrentEditor)
            {
                EditorPrefs.SetBool(key, true);
                return;
            }

            var install = Discovery.Find().FirstOrDefault();
            if (install == null)
                return; // PAPyrus hasn't been launched yet; try again next reload

            if (!SetExternalEditor(install))
                return;
            EditorPrefs.SetBool(key, true);
            new ProjectGeneration().Sync();
            Debug.Log("[PAPyrus] External Script Editor를 PAPyrus로 설정했어요. (Edit > Preferences > External Tools에서 바꿀 수 있어요)");
        }

        internal static bool IsCurrentEditor
        {
            get
            {
                var path = CodeEditor.CurrentEditorInstallation;
                return !string.IsNullOrEmpty(path) && Discovery.IsPapyrus(path);
            }
        }

        // Unity 2019–2020: static CodeEditor.SetExternalScriptEditor(path)
        // Unity 2021.2+: CodeEditor.Editor.SetCodeEditor(path). Use reflection to support both.
        static bool SetExternalEditor(string path)
        {
            try
            {
                var t = typeof(CodeEditor);
                var flags = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static;
                var editorProp = t.GetProperty("Editor", flags);
                var editor = editorProp != null ? editorProp.GetValue(null, null) : null;
                var setCodeEditor = editor != null ? editor.GetType().GetMethod("SetCodeEditor", new[] { typeof(string) }) : null;
                if (setCodeEditor != null)
                {
                    setCodeEditor.Invoke(editor, new object[] { path });
                    return true;
                }

                var legacy = t.GetMethod("SetExternalScriptEditor", flags, null, new[] { typeof(string) }, null);
                if (legacy != null)
                {
                    legacy.Invoke(null, new object[] { path });
                    return true;
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning("[PAPyrus] 외부 에디터 자동 설정 실패: " + e.Message);
            }

            return false;
        }

        public CodeEditor.Installation[] Installations
        {
            get
            {
                return Discovery.Find()
                    .Select(p => new CodeEditor.Installation { Name = DisplayName, Path = p })
                    .ToArray();
            }
        }

        public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
        {
            if (!string.IsNullOrEmpty(editorPath) && Discovery.IsPapyrus(editorPath))
            {
                installation = new CodeEditor.Installation { Name = DisplayName, Path = editorPath };
                return true;
            }

            installation = default(CodeEditor.Installation);
            return false;
        }

        public void Initialize(string editorInstallationPath)
        {
            m_Installation = editorInstallationPath;
        }

        public void OnGUI()
        {
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("PAPyrus", EditorStyles.boldLabel);

            var status = PapyrusBridge.ConnectedClients > 0 ? "IDE 연결됨" : "IDE 연결 대기 중 (포트 " + PapyrusBridge.Port + ")";
            EditorGUILayout.LabelField("상태", status);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("프로젝트 파일(.csproj)을 만들 패키지", EditorStyles.miniBoldLabel);
            EditorGUI.indentLevel++;
            PapyrusSettings.Embedded = EditorGUILayout.Toggle("Embedded 패키지", PapyrusSettings.Embedded);
            PapyrusSettings.Local = EditorGUILayout.Toggle("Local 패키지", PapyrusSettings.Local);
            PapyrusSettings.Registry = EditorGUILayout.Toggle("Registry 패키지", PapyrusSettings.Registry);
            PapyrusSettings.Git = EditorGUILayout.Toggle("Git 패키지", PapyrusSettings.Git);
            PapyrusSettings.BuiltIn = EditorGUILayout.Toggle("Built-in 패키지", PapyrusSettings.BuiltIn);
            EditorGUI.indentLevel--;

            EditorGUILayout.Space();
            PapyrusSettings.SyncOnOpen = EditorGUILayout.Toggle("열 때마다 프로젝트 파일 갱신", PapyrusSettings.SyncOnOpen);

            EditorGUILayout.Space();
            if (GUILayout.Button("프로젝트 파일 다시 생성", GUILayout.Width(200)))
                m_Generator.Sync();
        }

        public void SyncIfNeeded(string[] addedFiles, string[] deletedFiles, string[] movedFiles, string[] movedFromFiles, string[] importedFiles)
        {
            var affected = (addedFiles ?? new string[0])
                .Concat(deletedFiles ?? new string[0])
                .Concat(movedFiles ?? new string[0])
                .Concat(movedFromFiles ?? new string[0]);
            m_Generator.SyncIfNeeded(affected, importedFiles ?? new string[0]);
        }

        public void SyncAll()
        {
            AssetDatabase.Refresh();
            m_Generator.Sync();
        }

        public bool OpenProject(string filePath = "", int line = -1, int column = -1)
        {
            if (!string.IsNullOrEmpty(filePath) && !s_SupportedExtensions.Contains(Path.GetExtension(filePath)))
                return false; // let Unity open it with the default app

            if (PapyrusSettings.SyncOnOpen || !m_Generator.HasSolutionBeenGenerated())
                m_Generator.Sync();

            var root = ProjectGeneration.ProjectDirectory;
            var fullPath = string.IsNullOrEmpty(filePath) ? string.Empty : Path.GetFullPath(filePath);
            line = Math.Max(1, line);
            column = Math.Max(1, column);

            // Fast path: the IDE is already connected for this project.
            if (PapyrusBridge.TryOpen(fullPath, line, column))
                return true;

            var exe = !string.IsNullOrEmpty(m_Installation) ? m_Installation : CodeEditor.CurrentEditorInstallation;
            if (string.IsNullOrEmpty(exe) || !(File.Exists(exe) || Directory.Exists(exe)))
            {
                exe = Discovery.Find().FirstOrDefault();
                if (exe == null)
                {
                    Debug.LogWarning("[PAPyrus] 실행 파일을 찾을 수 없어요. Preferences > External Tools에서 PAPyrus.exe를 직접 선택해 주세요.");
                    return false;
                }
            }

            var args = "--project " + Quote(root);
            if (!string.IsNullOrEmpty(fullPath))
                args += " --goto " + Quote(fullPath + ":" + line + ":" + column);

            try
            {
                PapyrusBridge.AllowForeground();
                ProcessStartInfo psi;
                if (exe.EndsWith(".app", StringComparison.OrdinalIgnoreCase))
                    psi = new ProcessStartInfo("open", "-n " + Quote(exe) + " --args " + args) { UseShellExecute = false };
                else
                    psi = new ProcessStartInfo(exe, args) { UseShellExecute = true, WorkingDirectory = root };
                Process.Start(psi);
                return true;
            }
            catch (Exception e)
            {
                Debug.LogError("[PAPyrus] 실행 실패: " + e.Message);
                return false;
            }
        }

        static string Quote(string s)
        {
            return "\"" + s.Replace("\"", "\\\"") + "\"";
        }

        [MenuItem("Tools/PAPyrus/프로젝트 파일 다시 생성", priority = 100)]
        static void RegenerateMenu()
        {
            new ProjectGeneration().Sync();
            Debug.Log("[PAPyrus] 프로젝트 파일을 다시 생성했어요.");
        }

        [MenuItem("Tools/PAPyrus/PAPyrus에서 열기", priority = 101)]
        static void OpenMenu()
        {
            new PapyrusCodeEditor().OpenProject();
        }
    }

    internal static class Discovery
    {
        public static bool IsPapyrus(string path)
        {
            var name = Path.GetFileNameWithoutExtension(path.TrimEnd('/', '\\')) ?? string.Empty;
            return name.Replace(" ", string.Empty).IndexOf("papyrus", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static IEnumerable<string> UserDataDirs()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var home = Environment.GetFolderPath(Environment.SpecialFolder.Personal);
            yield return Path.Combine(appData, "PAPyrus");
            yield return Path.Combine(home, "Library", "Application Support", "PAPyrus");
            yield return Path.Combine(home, ".config", "PAPyrus");
        }

        /// <summary>Microsoft.Unity.Analyzers downloaded by the IDE, if present.</summary>
        public static string UnityAnalyzers
        {
            get
            {
                foreach (var dir in UserDataDirs())
                {
                    var p = Path.Combine(dir, "analyzers", "Microsoft.Unity.Analyzers.dll");
                    if (File.Exists(p))
                        return p;
                }
                return null;
            }
        }

        public static IEnumerable<string> Find()
        {
            var candidates = new List<string>();
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            // The IDE writes its own location here on every launch (covers portable installs).
            foreach (var hint in UserDataDirs().Select(d => Path.Combine(d, "install-path.txt")))
            {
                try
                {
                    if (File.Exists(hint))
                        candidates.Add(File.ReadAllText(hint).Trim());
                }
                catch (Exception)
                {
                    // ignore unreadable hint files
                }
            }

            candidates.Add(Path.Combine(localAppData, "Programs", "PAPyrus", "PAPyrus.exe"));
            candidates.Add(Path.Combine(localAppData, "Programs", "papyrus", "PAPyrus.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PAPyrus", "PAPyrus.exe"));
            candidates.Add("/Applications/PAPyrus.app");

            var result = new List<string>();
            foreach (var c in candidates)
            {
                if (string.IsNullOrEmpty(c))
                    continue;
                var path = c;
                // macOS: install-path.txt points inside the bundle
                var idx = path.IndexOf(".app/", StringComparison.OrdinalIgnoreCase);
                if (idx > 0)
                    path = path.Substring(0, idx + 4);
                if ((File.Exists(path) || Directory.Exists(path)) && !result.Contains(path, StringComparer.OrdinalIgnoreCase))
                    result.Add(path);
            }

            return result;
        }
    }

    internal static class PapyrusSettings
    {
        const string k_Prefix = "Papyrus.Ide.";

        public static bool Embedded { get { return Get("Embedded", true); } set { Set("Embedded", value); } }
        public static bool Local { get { return Get("Local", true); } set { Set("Local", value); } }
        public static bool Registry { get { return Get("Registry", false); } set { Set("Registry", value); } }
        public static bool Git { get { return Get("Git", false); } set { Set("Git", value); } }
        public static bool BuiltIn { get { return Get("BuiltIn", false); } set { Set("BuiltIn", value); } }
        public static bool SyncOnOpen { get { return Get("SyncOnOpen", false); } set { Set("SyncOnOpen", value); } }

        static bool Get(string key, bool def)
        {
            return EditorPrefs.GetBool(k_Prefix + key, def);
        }

        static void Set(string key, bool value)
        {
            var k = k_Prefix + key;
            if (EditorPrefs.HasKey(k) && EditorPrefs.GetBool(k) == value)
                return;
            EditorPrefs.SetBool(k, value);
        }
    }
}
