"""เพิ่มตารางเซสชันของบัญชีผู้ใช้

Revision ID: b7c3e19f4a08
Revises: 231dce52a4eb
Create Date: 2026-10-06 00:00:00.000000

ทำให้การเปลี่ยนรหัสผ่านและการแบนมีผลจริง เพราะทุกทางที่เข้ามา
ต้องถูกปิด ไม่ใช่แค่ทางที่คนรู้

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7c3e19f4a08"
down_revision: str | Sequence[str] | None = "231dce52a4eb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "player_sessions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("player_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            # ลบผู้เล่นแล้วเซสชันต้องหายตาม ไม่ใช่ค้างเป็นเซสชันของใครไม่มี
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        # unique เพราะแฮชซ้ำกันไม่ได้ ถ้าไม่บังคับจะมีสองแถวชี้โทเคนเดียวกัน
        # และการยกเลิกแถวหนึ่งจะไม่ยกเลิกอีกแถว ทำให้การแบนไม่มีผล
        sa.UniqueConstraint("token_hash", name="uq_player_sessions_token"),
    )
    # การค้นหาเซสชันทุกคำขอต้องเร็ว และการยกเลิกทั้งหมดของคนหนึ่งก็ต้องเร็ว
    op.create_index("ix_player_sessions_player", "player_sessions", ["player_id"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_player_sessions_player", table_name="player_sessions")
    op.drop_table("player_sessions")
