// electron-builder config. Auto-update uses GitHub Releases of the repository this code lives in:
//  - in GitHub Actions, GITHUB_REPOSITORY ("owner/repo") is set automatically
//  - locally, set PAPYRUS_REPO=owner/repo, or add "repository" to package.json
const pkg = require('./package.json');

function repoInfo() {
  const slug = process.env.PAPYRUS_REPO || process.env.GITHUB_REPOSITORY;
  if (slug && slug.includes('/')) {
    const [owner, repo] = slug.split('/');
    return { owner, repo };
  }
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  const m = url && url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : {};
}

module.exports = {
  appId: 'dev.papyrus.ide',
  productName: 'PAPyrus',
  directories: { output: 'release', buildResources: 'build' },
  files: ['package.json', 'src/main/**', 'src/preload/**', 'dist/**', 'build/icon.png', '!**/*.map'],
  extraResources: [{ from: 'unity-package', to: 'unity-package', filter: ['**/*'] }],
  asar: true,
  afterPack: 'scripts/after-pack.cjs',
  // Without repo info the build still works; the installed app then reads "update.repo" from settings.
  publish: [{ provider: 'github', releaseType: 'release', ...(repoInfo().owner ? repoInfo() : { owner: 'YOUR_GITHUB_ID', repo: 'papyrus' }) }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: true, // double-click -> installed -> launched. No questions.
    perMachine: false, // per-user: no admin rights needed, updates install silently
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'PAPyrus',
    artifactName: 'PAPyrus-Setup-${version}.${ext}',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    deleteAppDataOnUninstall: false,
  },
  mac: { target: 'dmg', icon: 'build/icon.png', category: 'public.app-category.developer-tools' },
  linux: { target: 'AppImage', icon: 'build/icon.png' },
};
