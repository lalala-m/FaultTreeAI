import base64
import hmac
import random
import struct
import time
from collections import OrderedDict
from hashlib import sha256

VERSION = "001"

PRIV_PUBLISH_STREAM = 0
_PRIV_PUBLISH_AUDIO_STREAM = 1
_PRIV_PUBLISH_VIDEO_STREAM = 2
_PRIV_PUBLISH_DATA_STREAM = 3
PRIV_SUBSCRIBE_STREAM = 4


def _pack_uint16(x: int) -> bytes:
    return struct.pack("<H", int(x))


def _pack_uint32(x: int) -> bytes:
    return struct.pack("<I", int(x))


def _pack_bytes(raw: bytes) -> bytes:
    return _pack_uint16(len(raw)) + raw


def _pack_string(text: str) -> bytes:
    return _pack_bytes(str(text or "").encode("utf-8"))


def _pack_map_uint32(data: dict[int, int]) -> bytes:
    ordered = OrderedDict(sorted((int(k), int(v)) for k, v in data.items()))
    buf = _pack_uint16(len(ordered))
    for key, value in ordered.items():
        buf += _pack_uint16(key)
        buf += _pack_uint32(value)
    return buf


class AccessToken:
    def __init__(self, app_id: str, app_key: str, room_id: str, user_id: str):
        random.seed(time.time())
        self.app_id = str(app_id or "")
        self.app_key = str(app_key or "")
        self.room_id = str(room_id or "")
        self.user_id = str(user_id or "")
        self.issued_at = int(time.time())
        self.nonce = random.randint(1, 99_999_999)
        self.expire_at = 0
        self.privileges: dict[int, int] = {}

    def add_privilege(self, privilege: int, expire_ts: int) -> None:
        expire_ts = int(expire_ts or 0)
        privilege = int(privilege)
        self.privileges[privilege] = expire_ts
        if privilege == PRIV_PUBLISH_STREAM:
            self.privileges[_PRIV_PUBLISH_AUDIO_STREAM] = expire_ts
            self.privileges[_PRIV_PUBLISH_VIDEO_STREAM] = expire_ts
            self.privileges[_PRIV_PUBLISH_DATA_STREAM] = expire_ts

    def expire_time(self, expire_ts: int) -> None:
        self.expire_at = int(expire_ts or 0)

    def _pack_message(self) -> bytes:
        buf = _pack_uint32(self.nonce)
        buf += _pack_uint32(self.issued_at)
        buf += _pack_uint32(self.expire_at)
        buf += _pack_string(self.room_id)
        buf += _pack_string(self.user_id)
        buf += _pack_map_uint32(self.privileges)
        return buf

    def serialize(self) -> str:
        msg = self._pack_message()
        signature = hmac.new(self.app_key.encode("utf-8"), msg, sha256).digest()
        content = _pack_bytes(msg) + _pack_bytes(signature)
        return VERSION + self.app_id + base64.b64encode(content).decode("utf-8")
