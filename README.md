# PAPyrus

<img src="build/icon256.png" width="96" alt="PAPyrus">

Unity용으로 만든 가벼운 C# IDE예요. 화면 구성은 Rider를 따라 했고, 단축키는 VS Code 키맵이 기본이에요. 개인 프로젝트에 쓰려고 만들었고, 배포·판매용이 아니에요.

- **에디터**: Monaco(VS Code의 에디터 엔진), JetBrains Mono, Rider풍 어두운·밝은 색 구성(시맨틱 하이라이팅 포함)
- **C# 언어 기능**: Roslyn 언어 서버(`roslyn-language-server`, MIT)
  - 자동완성(↑·↓로 고른 뒤 Tab·Enter로 확정, Ctrl+Space로 직접 호출, using이 없는 타입도 자동완성), 파라미터 힌트, 호버 문서
  - 실시간 오류·경고, 빠른 수정(Ctrl+.), 이름 바꾸기(닫힌 파일까지), 사용처 찾기, 선언·구현으로 이동
  - 코드 정리, 파라미터 이름 인레이 힌트, 참조 개수 코드 렌즈, 구조(Structure) 창, 브레드크럼
- **Unity에서 스크립트 열기**: Unity 환경설정에서 PAPyrus를 외부 스크립트 편집기로 고를 수 있어요.
- **Unity 실시간 연동 (선택)**: `com.papyrus.ide` 패키지
  - SDK 스타일 `.sln`/`.csproj`를 생성해요.
  - IDE 하단 **Unity Log**에 콘솔 로그가 표시되고, 파일 경로를 클릭하면 해당 위치로 이동해요.
  - 상단 툴바에서 **Play/Stop/Pause/Step**, 에셋 새로고침을 할 수 있어요. 저장하면 자동으로 새로고침돼요.
  - Microsoft.Unity.Analyzers를 적용해서 `Awake`/`Update`가 "사용 안 됨"으로 표시되지 않아요.
- 명령 팔레트, Search Everywhere(Shift 두 번), 파일·타입·심볼 검색, 파일에서 찾기, 최근 파일, 뒤로·앞으로 이동
- 어두운·밝은 테마, 설정 화면, 단축키 편집기(VS Code 키맵 기본), 자동 저장

## 설치 (Windows)

1. `PAPyrus-Setup-x.y.z.exe`를 실행해요. 묻는 창 없이 설치되고 바로 켜져요. 관리자 권한은 필요 없어요.
   - "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르면 돼요. 코드 서명을 안 한 앱이라서 뜨는 창이에요.
2. **폴더 열기**로 Unity 프로젝트 폴더(`Assets`가 있는 폴더)를 열어요.
3. **설정 도우미**에서 **C# 도구 자동 설정**을 누르세요.
   - .NET 10 SDK: winget으로 설치하고, 관리자 확인 창이 한 번 뜰 수 있어요.
   - C# 언어 서버
4. Unity의 **Edit → Preferences → External Tools → External Script Editor**에서 **PAPyrus**를 선택하세요.

실시간 콘솔, Play 제어, 라이브 인스펙터, SDK 스타일 프로젝트 파일 생성이 필요하면 메뉴(☰) → **설정 도우미**에서 **Unity 실시간 연동 (선택)**을 설치하세요. 연동 패키지는 Unity의 외부 스크립트 편집기 목록에 PAPyrus를 등록합니다.

### Unity 패키지 없이 스크립트 열기

**External Script Editor → Browse…**에서 설치된 `PAPyrus.exe`를 선택하세요. 저장소에서 개발 빌드를 실행한다면 `npm run build`가 만든 `node_modules/.cache/papyrus/PAPyrus.exe`를 선택하세요. PAPyrus의 **설정 도우미**에서 실행 파일 경로와 인자를 복사할 수 있어요.

Unity의 **External Script Editor Args**에 아래 인자를 입력하면 스크립트 경로, 줄, 열이 전달되고 **Assets → Open C# Project**로 프로젝트도 열 수 있어요.

```text
--project $(ProjectPath) --file $(File) --line $(Line) --column $(Column)
```

PAPyrus는 기존 Unity 솔루션이나 프로젝트 파일을 읽어 C# 언어 기능을 제공해요. 연동 패키지 없이 새 프로젝트의 솔루션이 필요하면 Unity에 설치된 다른 코드 편집기 연동에서 프로젝트 파일을 생성할 수 있어요.

## 자동 업데이트

새 버전이 올라오면 PAPyrus가 켜질 때(그리고 4시간마다) 알림이 떠요. **업데이트**를 누르면 내려받고, 진행률은 상태 표시줄에 보여요. 다 받으면 **지금 재시작**을 눌러 설치하면 돼요. 나중에 하면 PAPyrus를 끌 때 설치돼요.

업데이트는 GitHub Releases에서 받아요. 그래서 처음 한 번은 아래 설정이 필요해요.

### 한 번만 하는 준비

업데이트 저장소는 `projectpaper11/papyrus`로 설정돼 있어요.

1. GitHub에 이름이 **papyrus**인 **public** 저장소를 만들어요. https://github.com/new
2. 소스를 push해요.
   ```bash
   git init && git add . && git commit -m "PAPyrus 0.2.0"
   git branch -M main
   git remote add origin https://github.com/projectpaper11/papyrus.git
   git push -u origin main
   ```

저장소 이름을 다르게 하고 싶으면 `package.json`의 `repository`를 바꾸거나, 앱에서 **설정 → 업데이트 → 업데이트 저장소**를 바꾸면 돼요.

### 새 버전 배포

```bash
npm run release
```

이 명령 하나로 아래가 자동으로 진행돼요.

1. 버전이 올라가요(0.2.0 → 0.2.1). `-minor`나 `-major`가 필요하면 `npm version minor && git push --follow-tags`를 쓰면 돼요.
2. 태그가 push돼요.
3. GitHub Actions(`.github/workflows/release.yml`)가 Windows에서 설치 파일을 빌드해요.
4. Release가 게시되고, 설치된 PAPyrus에 업데이트 알림이 떠요.

Release 페이지에 적은 설명은 업데이트 알림에 같이 표시돼요. 저장소가 private이면 업데이트를 받을 수 없으니 public으로 두세요.

## 단축키 (Visual Studio Code 키맵 기준)

설정(**Ctrl+,**) → **단축키**에서 모든 명령의 단축키를 바꿀 수 있어요. 키를 직접 눌러서 녹화하는 방식이고, `Ctrl+K Ctrl+S`처럼 두 번 누르는 조합도 돼요. 같은 키를 쓰는 명령이 있으면 노란 테두리로 표시돼요. 단축키는 키 위치 기준으로 인식해서 한글 입력 상태에서도 동작해요.

| 기능 | 키 |
|---|---|
| 파일로 이동 / 명령 팔레트 | Ctrl+P / Ctrl+Shift+P (F1) |
| 작업 영역 심볼 / 파일의 심볼 | Ctrl+T / Ctrl+Shift+O |
| 최근 파일 / Search Everywhere | Ctrl+E / Shift 두 번 |
| 정의 / 구현 / 참조 미리 보기 / 모든 참조 | F12 / Ctrl+F12 / Shift+F12 / Shift+Alt+F12 |
| 이름 바꾸기 / 빠른 수정 | F2 / Ctrl+. |
| 문서 서식 / 선택 영역 서식 | Shift+Alt+F / Ctrl+K Ctrl+F |
| 줄 복사 / 줄 이동 / 줄 삭제 | Shift+Alt+↓ / Alt+↓ / Ctrl+Shift+K |
| 다음 일치 항목 선택 / 모두 선택 | Ctrl+D / Ctrl+Shift+L |
| 선택 확장 / 축소 | Shift+Alt+→ / Shift+Alt+← |
| 다음 / 이전 문제 | F8 / Shift+F8 |
| 뒤로 / 앞으로 | Alt+← / Alt+→ |
| 저장 / 모두 저장 | Ctrl+S / Ctrl+K S |
| 사이드바 / 하단 패널 | Ctrl+B / Ctrl+J |
| 파일에서 찾기 | Ctrl+Shift+F |
| 새 C# 스크립트 | Ctrl+N |
| Unity Play·Stop / Stop / Pause / Step | F5 / Shift+F5 / F6 / F10 |
| Unity 에셋 새로고침 | Ctrl+Alt+R |
| Unity Log / Problems / Output | Ctrl+Shift+Y / Ctrl+Shift+M / Ctrl+Shift+U |
| 설정 / 단축키 설정 | Ctrl+, / Ctrl+K Ctrl+S |
| 테마 전환 | Ctrl+K Ctrl+T |

## 설정

**Ctrl+,**를 누르면 설정 탭이 열리고, 바꾸는 즉시 적용돼요.

- **모양**: 테마(어두운 / 밝은 / 시스템 설정 따르기), 글꼴, 글자 크기, 줄 간격, 합자, 미니맵, 파라미터 힌트, 참조 개수 표시
- **에디터**: 탭 크기, 공백, 자동 줄 바꿈, 저장 시 서식 적용
- **파일**: 자동 저장(입력을 멈추면 / 탭·창 전환 시), 제외할 폴더
- **Unity**: 저장하면 에셋 새로고침, Play할 때 로그 지우기
- **C# 언어 서버**: 서버 경로(OmniSharp도 가능), 자동 복원
- **단축키**: 위 표 참고

모든 설정은 `settings.json`에도 저장돼요. 설정 화면 왼쪽 아래의 **settings.json 열기**로 직접 편집할 수도 있어요.

## 직접 빌드

```bash
npm install
npm start          # 개발 실행
npm run dist       # release/ 에 설치 파일(PAPyrus-Setup-x.y.z.exe) 생성
npm run release    # 버전 올리고 태그 push → GitHub Actions가 빌드·배포
```

Linux에서 Windows용 설치 파일을 빌드하려면 wine이 필요해요.

## 알려진 제한

- 디버거(중단점)는 없어요.
- Unity가 꺼져 있을 때 새로 만든 스크립트는 Unity가 `.csproj`를 다시 만들 때까지 자동완성이 제한돼요. Unity를 켜면 IDE가 자동으로 동기화를 요청해요.
- 리팩터링 중 "중첩 액션"(옵션을 고르는 생성 마법사류)은 아직 지원하지 않아요.
