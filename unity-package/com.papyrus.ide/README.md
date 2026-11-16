# PAPyrus Integration (com.papyrus.ide)

Unity 2021.3 이상.

1. PAPyrus에서 프로젝트를 열고 메뉴 → **Unity 패키지 설치/업데이트**를 누르거나, 이 폴더를 `<프로젝트>/Packages/com.papyrus.ide`에 복사합니다.
2. Unity에서 **Edit > Preferences > External Tools > External Script Editor**를 **PAPyrus**로 바꿉니다.
   목록에 없으면 **Browse...**로 `PAPyrus.exe`를 고르세요.
3. 스크립트를 더블클릭하면 PAPyrus에서 열립니다. Unity가 켜져 있으면 IDE 상단에 연결 상태와 Play/Stop 버튼이 활성화됩니다.

- 프로젝트 파일은 SDK 스타일 `.csproj`로 생성되며, obj 파일은 `Temp/obj` 아래에 생깁니다.
- 연동 포트는 `Temp/PAPyrus/bridge.json`에 기록됩니다 (localhost 전용).
