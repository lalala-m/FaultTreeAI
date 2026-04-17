import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.config import settings


router = APIRouter(prefix="/api/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=False)

_JWT_SECRET = settings.JWT_SECRET or ("dev-" + secrets.token_urlsafe(32))

def _jwt_secret() -> str:
    return _JWT_SECRET


def _ensure_users_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(64) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(16) NOT NULL,
                full_name VARCHAR(64) NOT NULL DEFAULT '',
                phone VARCHAR(32) NOT NULL DEFAULT '',
                employee_id VARCHAR(32) NOT NULL DEFAULT '',
                title VARCHAR(64) NOT NULL DEFAULT '',
                avatar_base64 TEXT NOT NULL DEFAULT '',
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS ux_users_employee_id
            ON users(employee_id)
            WHERE employee_id <> ''
            """
        )
        conn.commit()


def _hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    iterations = 120_000
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iterations, dklen=32)
    salt_b64 = base64.urlsafe_b64encode(salt).decode("utf-8").rstrip("=")
    dk_b64 = base64.urlsafe_b64encode(dk).decode("utf-8").rstrip("=")
    return f"pbkdf2_sha256${iterations}${salt_b64}${dk_b64}"


def _verify_password(pw: str, pw_hash: str) -> bool:
    ph = str(pw_hash or "")
    if not ph.startswith("pbkdf2_sha256$"):
        return False
    parts = ph.split("$")
    if len(parts) != 4:
        return False
    try:
        iterations = int(parts[1])
        salt_b64 = parts[2]
        dk_b64 = parts[3]
        salt = base64.urlsafe_b64decode(salt_b64 + "=" * ((4 - len(salt_b64) % 4) % 4))
        expected = base64.urlsafe_b64decode(dk_b64 + "=" * ((4 - len(dk_b64) % 4) % 4))
    except Exception:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iterations, dklen=len(expected))
    return hmac.compare_digest(dk, expected)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _b64url_decode(s: str) -> bytes:
    ss = str(s or "")
    ss += "=" * ((4 - len(ss) % 4) % 4)
    return base64.urlsafe_b64decode(ss.encode("utf-8"))


def _create_access_token(user: dict) -> str:
    now = datetime.utcnow()
    exp = now + timedelta(minutes=int(settings.JWT_EXPIRE_MINUTES or 60))
    payload = {
        "sub": str(user["user_id"]),
        "username": user["username"],
        "role": user["role"],
        "employee_id": str(user.get("employee_id") or ""),
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _b64url_encode(json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    payload_b64 = _b64url_encode(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    msg = f"{header_b64}.{payload_b64}".encode("utf-8")
    sig = hmac.new(_jwt_secret().encode("utf-8"), msg, hashlib.sha256).digest()
    sig_b64 = _b64url_encode(sig)
    return f"{header_b64}.{payload_b64}.{sig_b64}"


def _decode_access_token(token: str) -> dict:
    parts = str(token or "").split(".")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="无效 token")
    header_b64, payload_b64, sig_b64 = parts
    msg = f"{header_b64}.{payload_b64}".encode("utf-8")
    expected_sig = hmac.new(_jwt_secret().encode("utf-8"), msg, hashlib.sha256).digest()
    try:
        sig = _b64url_decode(sig_b64)
        payload_raw = _b64url_decode(payload_b64)
        payload = json.loads(payload_raw.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=401, detail="无效 token")
    if not hmac.compare_digest(sig, expected_sig):
        raise HTTPException(status_code=401, detail="无效 token")
    exp = int(payload.get("exp") or 0)
    if exp and int(datetime.utcnow().timestamp()) > exp:
        raise HTTPException(status_code=401, detail="token 已过期")
    return payload


def _read_user_by_employee_id(conn, employee_id: str) -> dict | None:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT user_id, username, password_hash, role, full_name, phone, employee_id, title, avatar_base64, status
            FROM users
            WHERE employee_id = %s
            LIMIT 1
            """,
            (employee_id,),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def _read_user_by_id(conn, user_id: str) -> dict | None:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT user_id, username, role, full_name, phone, employee_id, title, avatar_base64, status
            FROM users
            WHERE user_id::text = %s
            LIMIT 1
            """,
            (user_id,),
        )
        row = cur.fetchone()
        return dict(row) if row else None


def _public_user(u: dict) -> dict:
    return {
        "user_id": str(u.get("user_id") or ""),
        "username": str(u.get("username") or ""),
        "role": str(u.get("role") or ""),
        "full_name": str(u.get("full_name") or ""),
        "phone": str(u.get("phone") or ""),
        "employee_id": str(u.get("employee_id") or ""),
        "title": str(u.get("title") or ""),
        "avatar_base64": str(u.get("avatar_base64") or ""),
        "status": str(u.get("status") or ""),
    }


def get_current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=401, detail="未登录")
    token = creds.credentials
    payload = _decode_access_token(token)
    user_id = str(payload.get("sub") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="无效 token")

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_users_table(conn)
        user = _read_user_by_id(conn, user_id)
        if not user or str(user.get("status") or "") != "active":
            raise HTTPException(status_code=401, detail="账号不可用")
        return user


def require_expert(user: dict = Depends(get_current_user)) -> dict:
    if str(user.get("role") or "") != "expert":
        raise HTTPException(status_code=403, detail="仅专家可访问")
    return user


class RegisterRequest(BaseModel):
    employee_id: str = Field(..., min_length=1, max_length=32)
    full_name: str = Field(default="", max_length=64)
    password: str = Field(..., min_length=6, max_length=128)
    role: str = Field(..., pattern="^(worker|expert)$")


class LoginRequest(BaseModel):
    employee_id: str
    password: str


class UpdateProfileRequest(BaseModel):
    full_name: str = ""
    phone: str = ""
    employee_id: str = ""
    title: str = ""


@router.post("/register")
async def register(req: RegisterRequest):
    employee_id = str(req.employee_id or "").strip()
    if not employee_id:
        raise HTTPException(status_code=400, detail="工号不能为空")
    username = employee_id
    full_name = str(req.full_name or "").strip()[:64]
    role = str(req.role or "").strip()
    if role not in {"worker", "expert"}:
        raise HTTPException(status_code=400, detail="role 不合法")
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_users_table(conn)
        if _read_user_by_employee_id(conn, employee_id):
            raise HTTPException(status_code=400, detail="工号已存在")
        pw_hash = _hash_password(req.password)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users(username, password_hash, role, employee_id, full_name)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING user_id::text
                """,
                (username, pw_hash, role, employee_id, full_name),
            )
            user_id = (cur.fetchone() or [None])[0]
            conn.commit()
        user = _read_user_by_id(conn, str(user_id))
        token = _create_access_token({**user, "user_id": user_id})
        return {"token": token, "user": _public_user(user)}


@router.post("/login")
async def login(req: LoginRequest):
    employee_id = str(req.employee_id or "").strip()
    if not employee_id:
        raise HTTPException(status_code=400, detail="工号不能为空")
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_users_table(conn)
        user = _read_user_by_employee_id(conn, employee_id)
        if not user or str(user.get("status") or "") != "active":
            raise HTTPException(status_code=401, detail="工号或密码错误")
        if not _verify_password(str(req.password or ""), str(user.get("password_hash") or "")):
            raise HTTPException(status_code=401, detail="工号或密码错误")
        token = _create_access_token(user)
        user_public = _public_user(user)
        user_public.pop("password_hash", None)
        return {"token": token, "user": user_public}


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return {"user": _public_user(user)}


@router.put("/me")
async def update_me(req: UpdateProfileRequest, user: dict = Depends(get_current_user)):
    employee_id = str(req.employee_id or "").strip()[:32]
    if not employee_id:
        raise HTTPException(status_code=400, detail="工号不能为空")
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_users_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT user_id::text FROM users
                WHERE employee_id = %s AND user_id::text <> %s
                LIMIT 1
                """,
                (employee_id, str(user.get("user_id") or "")),
            )
            if cur.fetchone():
                raise HTTPException(status_code=400, detail="工号已存在")
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET full_name=%s, phone=%s, employee_id=%s, title=%s, updated_at=NOW()
                WHERE user_id::text=%s
                """,
                (
                    str(req.full_name or "").strip()[:64],
                    str(req.phone or "").strip()[:32],
                    employee_id,
                    str(req.title or "").strip()[:64],
                    str(user.get("user_id") or ""),
                ),
            )
            conn.commit()
        updated = _read_user_by_id(conn, str(user.get("user_id") or ""))
        return {"user": _public_user(updated)}


@router.post("/me/avatar")
async def upload_avatar(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="头像过大（最多2MB）")
    b64 = base64.b64encode(data).decode("utf-8")
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_users_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET avatar_base64=%s, updated_at=NOW()
                WHERE user_id::text=%s
                """,
                (b64, str(user.get("user_id") or "")),
            )
            conn.commit()
        updated = _read_user_by_id(conn, str(user.get("user_id") or ""))
        return {"user": _public_user(updated)}
