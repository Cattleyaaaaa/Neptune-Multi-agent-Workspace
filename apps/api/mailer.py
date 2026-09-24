"""注册验证码邮件。

只做一件事：把 6 位验证码发给收件人。用标准库 `smtplib`（零依赖）。
**未配置 SMTP 时明确抛错** —— 调用方要把它翻成明确的 503，不假装发过信。
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from apps.api.settings import settings

logger = logging.getLogger("neptune.mailer")


class MailNotConfiguredError(RuntimeError):
    """没有可用的 SMTP 配置。"""


def send_email_code(*, to: str, code: str, ttl_minutes: int) -> None:
    if not settings.smtp_configured():
        raise MailNotConfiguredError("未配置邮件服务")

    message = EmailMessage()
    message["Subject"] = "Neptune 注册验证码"
    message["From"] = formataddr(("Neptune", settings.smtp_from))
    message["To"] = to
    message.set_content(
        f"你的注册验证码是：{code}\n\n"
        f"{ttl_minutes} 分钟内有效，请勿转发给他人。\n"
        "如果这不是你本人的操作，忽略这封邮件即可。"
    )

    timeout = settings.smtp_timeout_seconds
    password = settings.smtp_password.get_secret_value() if settings.smtp_password else ""
    context = ssl.create_default_context()

    if settings.smtp_starttls:
        # 587 之类的端口：先明文连接再 STARTTLS 升级
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=timeout) as client:
            client.starttls(context=context)
            if settings.smtp_username:
                client.login(settings.smtp_username, password)
            client.send_message(message)
    else:
        # 465 之类的端口：隐式 SSL
        with smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, timeout=timeout, context=context
        ) as client:
            if settings.smtp_username:
                client.login(settings.smtp_username, password)
            client.send_message(message)

    logger.info("已向 %s 发送注册验证码", mask_email(to))


def mask_email(email: str) -> str:
    """日志里不留完整邮箱。"""
    name, _, domain = email.partition("@")
    if not domain:
        return "***"
    head = name[:2] if len(name) > 2 else name[:1]
    return f"{head}***@{domain}"
