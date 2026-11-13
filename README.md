# Account Desk

在本机运行的 ChatGPT 账号管理页，前端和后端放在同一个项目中。通过 HTTP 批量登录并读取 `https://chatgpt.com/api/auth/session`，集中查看账号状态、套餐和套餐到期时间，支持 Session JSON 与 Excel 导出。

## 功能

- 批量导入邮箱、密码、2FA，支持 CSV、JSON 和 `邮箱----密码----2FA` 文本。
- 每个账号使用独立 HTTP 会话，队列按顺序处理，页面显示进度和失败原因。
- 已保存的 Session 先向服务器检查，通过后跳过重复登录，队列显示“跳过重复授权”。
- 查看套餐、套餐到期时间及账号接口提供的手机信息。
- 导出 `/api/auth/session` 原始 JSON，单账号为对象，多账号为数组。
- 导出 Excel，包含账号、密码、2FA、套餐、是否接码和套餐到期时间。
- 密码、2FA、Cookie 和 Session 加密保存在本机。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | 20 或更新版本，建议使用当前 LTS |
| npm | 随 Node.js 安装 |
| uv | 用于创建 Python 虚拟环境和安装依赖 |
| Python | 安装脚本通过 uv 准备 Python 3.12 |
| 网络 | 能访问 npm、Python 包索引、`chatgpt.com`、`auth.openai.com` 和 `sentinel.openai.com` |

安装 Node.js 请使用 [Node.js 官网](https://nodejs.org/)。uv 的安装方式见 [uv 官方文档](https://docs.astral.sh/uv/getting-started/installation/)。

macOS / Linux 可使用官方安装命令安装 uv，然后重新打开终端。

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Windows 可在 PowerShell 中运行官方安装命令，然后重新打开 PowerShell。

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

## 快速启动

macOS、Linux 和 Windows PowerShell 都可以按以下顺序运行。

```sh
git clone https://github.com/xushanpei/gpt-account-manager.git
cd gpt-account-manager
npm ci
npm run setup
npm start
```

`npm run setup` 会创建项目自己的 `.venv`，准备 Python 3.12 并安装 HTTP 登录依赖。首次运行需要下载依赖，之后通常直接运行 `npm start` 即可。

启动后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。在启动服务的终端按 `Ctrl+C` 停止服务。

### macOS 双击启动

完成 Node.js 和 uv 安装后，进入项目目录。

1. 首次双击 `setup.command` 安装依赖。
2. 双击 `start.command` 启动。
3. 打开浏览器访问 `http://127.0.0.1:4317`。

如果脚本缺少执行权限，可先在终端运行以下命令。

```sh
chmod +x setup.command start.command
```

`start.command` 会读取 macOS 当前启用的 HTTPS 系统代理。通过 `npm start` 启动时，按下面的说明显式配置代理。

## 代理和配置

配置通过环境变量传入。以下本机端口是示例，请替换为你自己的代理地址。支持 HTTP(S) 和 SOCKS5 代理。

macOS / Linux 示例。

```sh
REAUTH_PROXY=http://127.0.0.1:7897 npm start
```

Windows PowerShell 示例。

```powershell
$env:REAUTH_PROXY = "http://127.0.0.1:7897"
npm start
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `4317` | 本地服务端口 |
| `REAUTH_PROXY` | 空 | HTTP 登录和状态查询使用的代理 |
| `HTTPS_PROXY` / `ALL_PROXY` | 空 | 未指定 `REAUTH_PROXY` 时的代理回退 |
| `ACCOUNT_DATA_DIR` | 项目下的 `data/` | 加密数据存储目录 |
| `ACCOUNT_PYTHON` | 项目 `.venv` 内的 Python | 自定义 Python 解释器绝对路径 |

修改环境变量后重新启动服务生效。代理应是你自己控制或信任的网络出口。

## 使用方法

### 1. 导入账号

点击“导入账号”，选择文件或粘贴内容。单次最多导入 1000 条，文件或请求体大小最多 2 MB。账号总数没有单独设置硬性上限，大规模使用尚未压测。

分隔文本每行一个账号。

```text
alice@example.com----your-password----JBSWY3DPEHPK3PXP
bob@example.com----another-password----
```

CSV 可带以下表头，字段含逗号或换行时使用标准 CSV 引号。

```csv
email,password,twofa
alice@example.com,your-password,JBSWY3DPEHPK3PXP
bob@example.com,another-password,
```

JSON 使用数组，也支持包含 `accounts` 数组的对象。

```json
[
  {
    "email": "alice@example.com",
    "password": "your-password",
    "twofa": "JBSWY3DPEHPK3PXP"
  }
]
```

以上账号和密钥均为格式示例。2FA 字段支持 Base32 验证器密钥或 `otpauth://` URI，当前按 SHA-1、6 位、30 秒生成 TOTP。登录需要账号密码，启用 2FA 的账号还需要对应密钥。

相同邮箱会更新已有记录。空密码或空 2FA 字段保留原值。整批数据先校验，通过后再更新。

### 2. 批量授权

勾选账号，点击“批量授权”。后端按顺序建立 HTTP 登录事务，处理密码和 TOTP，完成 ChatGPT 网页回调，再读取 `/api/auth/session`。

会话只有在接口返回 `accessToken`、匹配的账号邮箱和未到期的 `expires` 时才显示“会话就绪”。每个账号最多等待 7 分钟，可通过“停止队列”取消当前和剩余任务。

已有 Session 会先检查服务端有效性，通过后跳过密码和 2FA 登录。确认失效（HTTP 401、空会话或明确到期）后才重新登录。HTTP 403、429、服务异常和网络错误会停止该账号的本次尝试，可在排查后手动重试。

额外邮箱验证码、手机号验证、第三方身份提供方登录或人机验证目前需要通过其他方式完成，管理页会显示失败原因。

### 3. 检查状态和套餐

勾选账号后点击“检查状态”，复用保存的 Cookie 查询会话、套餐、手机信息和套餐到期时间。账号详情中可查看查询时间和依据。

- 套餐来自网页账号接口，无法读取时显示“未知”。
- 套餐到期时间来自当前账号的 `entitlement.expires_at`，界面和 Excel 按北京时间展示。接口未提供时显示“未知”，确认无付费订阅时显示“不适用”。
- 手机信息来自 `/backend-api/me`，展示明确的验证标记、关联手机号存在性或“未知”。历史是否接收过手机验证码无法由当前接口直接确认。
- 手机号本身不保存到账号记录，也不显示在列表中。

状态反映最近一次检查的结果。服务端后续可能撤销会话，账号套餐或关联信息也可能发生变化。

### 4. 导出 Session

勾选“会话就绪”的账号，点击“导出 Session”。文件保留 `/api/auth/session` 的原始响应，单账号导出对象，多账号导出对象数组。无效会话会被跳过，页面提示导出和跳过数量。

### 5. 导出 Excel

勾选账号，点击“导出 Excel”。Excel 包含以下列，并支持筛选和冻结表头。

| 列 | 内容 |
| --- | --- |
| 账号 | 邮箱 |
| 密码 | 导入保存的账号密码，按文本导出 |
| 2FA | 保存的验证器密钥，按文本导出 |
| 套餐 | 最近一次查询得到的套餐 |
| 是否接码 | 当前手机状态及历史接码未知说明 |
| 套餐到期时间（北京时间） | `entitlement.expires_at` 对应的北京时间 |

Excel 使用已保存的数据，尚未授权的账号也可以导出，缺失的查询字段显示“未知”。需要最新数据时，先执行“检查状态”，完成后再导出。

## 数据存储

默认目录为项目下的 `data/`。

- `data/accounts.enc` 保存 AES-256-GCM 加密的账号、密码、2FA 和会话。
- `data/vault.key` 保存本机解密密钥。

备份或迁移时，需要一起保留这两个文件。丢失密钥会导致已有加密数据无法读取。密钥与数据库位于同一台机器，加密无法防止已经能读取整个目录的本机用户访问资料。

导出的 JSON 和 Excel 含明文凭据。`data/`、导出文件、`.env`、虚拟环境和依赖目录均已加入 `.gitignore`。提交代码时请保持这些运行数据留在本机。

服务默认只监听 `127.0.0.1`，校验 Host、Origin 和跨站请求。本地管理页没有额外管理员登录，适合在自己的电脑上运行。需要远程访问时，应另行配置访问认证和 HTTPS。

删除管理页中的账号会删除本机保存的资料。服务端的账号和会话撤销需在对应服务中处理。

## 项目结构

```text
gpt-account-manager/
├── server.mjs              # 本地 HTTP 服务、静态页面和导出接口
├── accounts.mjs            # 导入解析、账号队列和进程管理
├── public/                 # HTML / CSS / JavaScript 管理页
├── protocol/
│   ├── worker.py           # HTTP 网页登录、Session 与套餐查询
│   ├── reauth/             # TOTP 支持
│   ├── vendor/             # 复用的 HTTP / OAuth 客户端
│   └── requirements.txt
├── excel/export.mjs        # 基于 ExcelJS 的 XLSX 导出
├── scripts/setup.mjs       # 跨平台 Python 依赖安装
├── setup.command           # macOS 首次安装入口
└── start.command           # macOS 启动入口
```

## 本地管理接口

所有接口由本机服务提供。JSON POST 请求需要 `Content-Type: application/json`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 脱敏账号状态和队列，返回账号 ID |
| POST | `/api/import` | `{"text":"账号导入内容"}` |
| POST | `/api/jobs` | `{"ids":["账号ID"],"mode":"authorize"}` 或 `mode: "check"` |
| POST | `/api/stop` | `{}`，停止当前队列 |
| POST | `/api/export` | `{"ids":["账号ID"]}`，返回有效会话及本机保存的关联信息 |
| POST | `/api/export-excel` | `{"ids":["账号ID"]}`，返回 XLSX |
| POST | `/api/delete` | `{"ids":["账号ID"]}`，删除本机记录 |

## 常见问题

**运行时提示 Node.js 版本过低**

运行 `node --version`，确认是 20 或更新版本。使用 nvm 时可在项目目录执行 `nvm use`，或先安装相应版本。

**提示找不到 uv、Python 或授权依赖**

安装 uv 后重新打开终端，运行 `npm run setup`。如果使用自建虚拟环境，可通过 `ACCOUNT_PYTHON` 指定安装了 `protocol/requirements.txt` 依赖的解释器。

**网络超时、HTTP 403 或 429**

检查本机网络和 `REAUTH_PROXY`。额外验证或网页接口变化也可能导致失败。查看账号详情中的具体错误，处理后手动重试。

**提示端口已占用**

停止占用端口的旧服务，或改用其他端口。例如 macOS / Linux 使用 `PORT=4318 npm start`，PowerShell 使用 `$env:PORT="4318"` 后运行 `npm start`。

**套餐到期时间或手机信息未知**

先执行“检查状态”。查询成功仍为未知时，表示接口未返回可确认的信息。Session 的到期时间和套餐到期时间分别来自不同字段。

**Excel 导出失败**

在项目目录重新运行 `npm ci`，并确认 Node.js 版本满足要求。

## 开发检查

```sh
npm run check
python -m compileall -q protocol
```

Python 命令可替换成虚拟环境解释器。macOS / Linux 为 `.venv/bin/python`，Windows 为 `.venv\Scripts\python.exe`。

JavaScript 语法、导入去重、凭据脱敏、TOTP、有效 Session 复用、手机信息解析及 Excel 文本和日期导出已做本地验证。HTTP 登录、Session 读取、Plus 套餐和到期时间曾在实际账号上验证。网页内部接口可能随产品更新失效，其他验证方式和套餐尚未逐一验证。

## 许可和致谢

本项目采用 [MIT 许可证](LICENSE)。

HTTP 登录、OAuth 流程和 TOTP 部分复用了 [boji1334/reauth-web](https://github.com/boji1334/reauth-web) 的 MIT 代码，固定来源提交为 `db8251817fd1baefc83c14c851135fb6078bc001`。上游许可及本地修改说明保留在 [protocol/LICENSE.reauth-web](protocol/LICENSE.reauth-web) 和 [protocol/NOTICE](protocol/NOTICE)。Excel 导出使用 [ExcelJS](https://github.com/exceljs/exceljs)。
