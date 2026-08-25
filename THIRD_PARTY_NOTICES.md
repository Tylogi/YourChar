# Third-Party Notices

This file records selected third-party code and runtime libraries used by
bundled integrations. It does not replace license metadata shipped with the
project's package dependencies.

## Microsoft MarkItDown

YourChar uses Microsoft MarkItDown 0.1.x in an isolated local Python worker to
convert supported Workspace documents into Markdown.

- Upstream: <https://github.com/microsoft/markitdown>
- License: MIT
- Local integration: only PDF, DOCX, PPTX, XLS/XLSX, HTML, CSV, and text
  conversion dependencies are installed; plugins and network-oriented extras
  are disabled.

## Twemoji

YourChar uses the `@twemoji/api` parser and locally served `twemoji-svg`
graphics so Emoji render consistently without an external CDN.

- Upstream: <https://github.com/jdecked/twemoji>
- Code license: MIT
- Graphics license: CC BY 4.0
- Copyright (c) 2022-present Jason Sofonia & Justine De Caires
- Copyright (c) 2014-2021 Twitter

## Tencent/openclaw-weixin

Portions of the Weixin iLink protocol implementation in
`src/im/local-wechat.ts` are derived from Tencent/openclaw-weixin release 2.4.6.

- Upstream: <https://github.com/Tencent/openclaw-weixin>
- Fixed source commit:
  <https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0>
- Upstream license at that commit:
  <https://github.com/Tencent/openclaw-weixin/blob/cef0bfc390393f716903e16d50408118047f87e0/LICENSE>
- Local changes: adapted the protocol to YourChar's bundled Channel Runtime,
  credential store, durable ingress spool, owner-only direct-message boundary,
  and outbox lease/ACK model; the implementation does not require an OpenClaw
  host.

Tencent is pleased to support the open source community by making
openclaw-weixin available.

Copyright (C) 2026 Tencent. All rights reserved.

openclaw-weixin is licensed under the MIT.

Terms of the MIT:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## @larksuiteoapi/node-sdk

The bundled Feishu/Lark connector imports `registerApp` and
`createLarkChannel` from the official `@larksuiteoapi/node-sdk` package,
version 1.71.1.

- Upstream: <https://github.com/larksuite/node-sdk>
- License: <https://github.com/larksuite/node-sdk/blob/main/LICENSE>

MIT License

Copyright (c) 2022 Lark Technologies Pte. Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice, shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
