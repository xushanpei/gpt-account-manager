"""HTTP-only ChatGPT web sign-in. Credentials enter through stdin only."""
import contextlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from vendor.lib.chatgpt_client import ChatGPTClient
from vendor.lib.oauth_client import OAuthClient
from reauth.totp import TotpMfaClient

class ProtocolError(Exception):
    pass

class InvalidSessionError(ProtocolError):
    pass

OUTPUT = sys.stdout

def emit(event, **data):
    OUTPUT.write(json.dumps({"event": event, **data}, ensure_ascii=False) + "\n")
    OUTPUT.flush()

class WebLoginClient(OAuthClient):
    def __init__(self, config, proxy, expected_callback):
        super().__init__(config, proxy=proxy, verbose=False)
        self.expected_callback = expected_callback
        self.web_callback = None

    def _parse_validated_callback_url(self, raw_url, expected_state="", redirect_uri=None):
        actual = urlparse(str(raw_url or ""))
        expected = urlparse(self.expected_callback)
        if (actual.scheme, actual.netloc, actual.path) != (expected.scheme, expected.netloc, expected.path):
            return None
        query = parse_qs(actual.query)
        code = query.get("code", [""])[0]
        state = query.get("state", [""])[0]
        if not code or not expected_state or state != expected_state:
            return None
        self.web_callback = raw_url
        return {"code": code, "state": state, "callback_url": raw_url}

    def _oauth_drive_external_login_for_continue(self, **kwargs):
        emit("step", message="通过 HTTP 提交邮箱与密码")
        return super()._oauth_drive_external_login_for_continue(**kwargs)

    def _oauth_complete_totp_mfa_for_continue(self, **kwargs):
        emit("step", message="本地生成并提交 2FA 验证码")
        return super()._oauth_complete_totp_mfa_for_continue(**kwargs)



def read_phone_status(client, access_token):
    """Report current profile evidence. An absent number cannot prove SMS history."""
    result = {
        "status": "unknown",
        "source": "/backend-api/me",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "message": "接口未提供历史接码记录，无法确认是否接过手机验证码",
    }
    try:
        response = client.session.get(
            "https://chatgpt.com/backend-api/me",
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            timeout=20,
        )
        if response.status_code != 200:
            result["message"] = f"手机信息查询返回 HTTP {response.status_code}，接码状态未知"
            return result
        profile = response.json()
        if not isinstance(profile, dict):
            return result
        for key in ("phone_number_verified", "phone_verified", "is_phone_verified"):
            if isinstance(profile.get(key), bool):
                verified = profile[key]
                result["status"] = "verified" if verified else "unverified"
                result["message"] = f"账号接口 {key} 返回 {'true' if verified else 'false'}，表示当前验证状态；历史接码记录未提供"
                return result
        number = profile.get("phone_number")
        if isinstance(number, str) and number.strip():
            result["status"] = "bound"
            result["message"] = "账号接口返回了关联手机号，未提供独立的验证结果或历史接码记录"
        elif "phone_number" in profile:
            result["message"] = "账号接口 phone_number 为空，历史是否接过手机验证码无法确认"
    except Exception:
        result["message"] = "手机信息读取失败，历史接码状态未知，可再次检查状态"
    return result


def read_session(client, email):
    emit("step", message="读取 chatgpt.com/api/auth/session")
    response = client.session.get("https://chatgpt.com/api/auth/session", headers={"Accept": "application/json", "Referer": "https://chatgpt.com/"}, timeout=30)
    if response.status_code == 401:
        raise InvalidSessionError("保存的 Session 已失效")
    if response.status_code != 200:
        raise ProtocolError(f"Session 接口返回 HTTP {response.status_code}，本次停止；可稍后重试")
    auth = response.json()
    if not isinstance(auth, dict) or not auth.get("accessToken"):
        raise InvalidSessionError("Session 接口没有返回 accessToken，网页登录尚未完成")
    if str((auth.get("user") or {}).get("email") or "").lower() != email.lower():
        raise ProtocolError("Session 返回邮箱与导入账号不一致")
    expires = datetime.fromisoformat(str(auth.get("expires") or "").replace("Z", "+00:00"))
    if expires <= datetime.now(timezone.utc):
        raise InvalidSessionError("Session 接口返回的会话已到期")
    emit("step", message="会话有效，正在获取套餐")
    plan = "unknown"
    subscription = {"status": "unknown", "expiresAt": None, "source": "/backend-api/accounts/check/v4-2023-04-27", "checkedAt": datetime.now(timezone.utc).isoformat()}
    try:
        billing = client.session.get("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", headers={"Authorization": f"Bearer {auth['accessToken']}"}, timeout=20)
        if billing.status_code == 200:
            data = billing.json()
            accounts = data.get("accounts") or {}
            ordering = data.get("account_ordering") or list(accounts)
            if ordering:
                selected = accounts.get(ordering[0], {})
                plan = (selected.get("account") or {}).get("plan_type") or "unknown"
                entitlement = selected.get("entitlement") or {}
                expiry = entitlement.get("expires_at")
                if isinstance(expiry, str) and expiry.strip():
                    parsed_expiry = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
                    if parsed_expiry.tzinfo is not None:
                        subscription["expiresAt"] = parsed_expiry.astimezone(timezone.utc).isoformat()
                        subscription["status"] = "known"
                elif plan == "free" and entitlement.get("has_active_subscription") is False:
                    subscription["status"] = "not_applicable"
    except Exception:
        pass
    emit("step", message="正在查询账号手机验证信息")
    phone = read_phone_status(client, auth["accessToken"])
    cookies = []
    for cookie in client.session.cookies.jar:
        if not any(cookie.domain.lstrip(".") == host or cookie.domain.lstrip(".").endswith("." + host) for host in ("chatgpt.com", "openai.com")):
            continue
        cookies.append({"name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path or "/", "expires": cookie.expires if cookie.expires is not None else -1, "secure": cookie.secure, "httpOnly": "HttpOnly" in cookie._rest, "sameSite": "Lax"})
    return {"plan": str(plan), "subscription": subscription, "phone": phone, "session": {"auth": auth, "storageState": {"cookies": cookies, "origins": []}, "userAgent": client.ua, "capturedAt": datetime.now(timezone.utc).isoformat()}}


def run(data):
    proxy = os.environ.get("REAUTH_PROXY") or os.environ.get("HTTPS_PROXY") or os.environ.get("ALL_PROXY") or ""
    client = ChatGPTClient(proxy=proxy, verbose=False, impersonate="chrome133a")
    client.current_email = data["email"]
    try:
        saved = data.get("session")
        if saved:
            for cookie in (saved.get("storageState") or {}).get("cookies", []):
                # CookieJar preserves cookie expiration and domain scoping.
                from http.cookiejar import Cookie
                domain = cookie["domain"]
                expiry = cookie.get("expires", -1)
                restored = Cookie(0, cookie["name"], cookie["value"], None, False, domain, True, domain.startswith("."), cookie.get("path", "/"), True, cookie.get("secure", False), int(expiry) if expiry > 0 else None, expiry <= 0, None, None, {"HttpOnly": None} if cookie.get("httpOnly") else {}, False)
                client.session.cookies.jar.set_cookie(restored)
            if saved.get("userAgent"):
                client.ua = saved["userAgent"]
                client.session.headers["User-Agent"] = client.ua
        if data["mode"] == "check":
            if not saved:
                raise ProtocolError("尚无网页会话，请先执行接口授权")
            return read_session(client, data["email"])
        if saved:
            try:
                result = read_session(client, data["email"])
                result["authorizationSkipped"] = True
                emit("step", message="已有有效 Session，已跳过重复授权")
                return result
            except InvalidSessionError:
                client.session.close()
                client = ChatGPTClient(proxy=proxy, verbose=False, impersonate="chrome133a")
                client.current_email = data["email"]
        if not data.get("password"):
            raise ProtocolError("接口授权需要账号密码，请补充后重新导入")
        emit("step", message="通过 HTTP 建立 ChatGPT 网页登录事务")
        if not client.visit_homepage():
            raise ProtocolError("ChatGPT 首页不可访问，请检查代理或网络，可能遇到验证挑战")
        csrf = client.get_csrf_token()
        if not csrf:
            raise ProtocolError("未取得网页 CSRF token，可能遇到验证挑战或接口变化")
        providers_response = client.session.get("https://chatgpt.com/api/auth/providers", timeout=30)
        if providers_response.status_code != 200:
            raise ProtocolError("无法读取网页登录提供方，可能遇到验证挑战")
        providers = providers_response.json()
        provider = providers.get("openai-sidetron") or providers.get("openai") or {}
        sign_in_url = provider.get("signinUrl") or "https://chatgpt.com/api/auth/signin/openai"
        sign_in_target = urlparse(sign_in_url)
        if sign_in_target.scheme != "https" or sign_in_target.netloc != "chatgpt.com" or sign_in_target.path not in ("/api/auth/signin/openai", "/api/auth/signin/openai-sidetron"):
            raise ProtocolError("网页登录提供方地址不符合预期")
        signin_response = client.session.post(sign_in_url, params={"prompt": "login", "login_hint": data["email"], "ext-oai-did": client.device_id}, data={"csrfToken": csrf, "callbackUrl": "https://chatgpt.com/", "json": "true"}, headers={"Accept": "application/json", "Origin": "https://chatgpt.com", "Referer": "https://chatgpt.com/"}, timeout=30)
        auth_url = signin_response.json().get("url") if signin_response.status_code == 200 else None
        if not auth_url:
            raise ProtocolError("网页登录入口未返回授权地址，可能需要适配登录接口")
        parsed = urlparse(auth_url)
        if parsed.scheme != "https" or parsed.hostname != "auth.openai.com":
            raise ProtocolError("网页登录入口返回了非预期授权域名")
        params = parse_qs(parsed.query)
        state = params.get("state", [""])[0]
        callback = params.get("redirect_uri", [""])[0]
        target = urlparse(callback)
        if target.scheme != "https" or target.netloc != "chatgpt.com" or target.path not in ("/api/auth/callback/openai", "/api/auth/callback/openai-sidetron") or not state:
            raise ProtocolError("网页登录事务的 state 或回调地址不符合预期")
        oauth = WebLoginClient({"sub2api_redirect_uri": callback, "oauth_phone_strategy": "sms", "sub2api_oauth_max_hops": 20}, proxy, callback)
        oauth.oauth_client_id = params.get("client_id", [""])[0]
        oauth.oauth_redirect_uri = callback
        try:
            result = oauth.authorize_external_oauth_url(auth_url, client, expected_state=state, email=data["email"], password=data["password"], mfa_client=TotpMfaClient(data.get("twofa", "")) if data.get("twofa") else None)
            if not result.get("ok") or not oauth.web_callback:
                reason = str(result.get("error") or "unknown")
                allowed = {"invalid_username_or_password": "邮箱或密码错误", "mfa_totp_secret_required": "需要配置 2FA 密钥", "mfa_primary_factor_required": "需要额外验证方式", "phone_required": "需要手机号验证", "email_otp_not_found": "需要邮箱验证码", "mfa_totp_factor_not_available": "未发现可用的 TOTP 验证方式", "mfa_totp_code_unavailable": "2FA 验证码不可用"}
                detail = reason if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,80}", reason) else "unexpected_auth_response"
                raise ProtocolError(allowed.get(reason, f"HTTP 登录未完成（{detail}），需要检查验证步骤或接口变化"))
            emit("step", message="提交网页登录回调并建立 Session Cookie")
            response = client.session.get(oauth.web_callback, allow_redirects=True, timeout=30)
            if response.status_code != 200:
                raise ProtocolError(f"网页登录回调返回 HTTP {response.status_code}")
            return read_session(client, data["email"])
        finally:
            oauth.session.close()
    finally:
        client.session.close()

if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        # Third-party library output is suppressed. Only structured bridge events leave stdout.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = run(request)
        emit("result", result=result)
    except ProtocolError as error:
        # These controlled errors contain no credentials or remote response bodies.
        message = str(error)
        if any(secret and secret in message for secret in (locals().get("request", {}).get("password"), locals().get("request", {}).get("twofa"))):
            message = "登录数据或响应格式有误"
        emit("error", message=message if len(message) < 150 else "登录数据或响应格式有误")
        sys.exit(1)
    except Exception as error:
        emit("error", message=f"HTTP 请求或响应解析失败（{type(error).__name__}），请检查网络和代理")
        sys.exit(1)
