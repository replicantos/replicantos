import type {
  Category,
  CategoryId,
  Channel,
  ChannelId,
  IsoTimestamp,
  Message,
  MessageId,
  Replicant,
  ReplicantChannelBinding,
  ReplicantId,
  UserId,
  WorkspaceId,
} from "@replicantos/core";

import { connectionFor, type ReplicantDatabase } from "./database.ts";
import {
  cappedLimit,
  optionalText,
  requiredText,
  safeDescendantPath,
  safeRelativePath,
} from "./validation.ts";

function mapCategory(row: Record<string, unknown>): Category {
  return {
    id: row.id as CategoryId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: row.name as string,
    position: row.position as number,
    createdAt: row.created_at as IsoTimestamp,
  };
}

function mapChannel(row: Record<string, unknown>): Channel {
  return {
    id: row.id as ChannelId,
    workspaceId: row.workspace_id as WorkspaceId,
    categoryId: row.category_id as CategoryId | null,
    kind: row.kind as Channel["kind"],
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string | null,
    archivedAt: row.archived_at as IsoTimestamp | null,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapReplicant(row: Record<string, unknown>): Replicant {
  return {
    id: row.id as ReplicantId,
    workspaceId: row.workspace_id as WorkspaceId,
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string | null,
    persona: row.persona as string,
    defaultHarness: row.default_harness as string,
    defaultModel: row.default_model as string | null,
    relativeWorkspacePath: row.relative_workspace_path as string,
    relativeMemoryPath: row.relative_memory_path as string,
    status: row.status as Replicant["status"],
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapBinding(row: Record<string, unknown>): ReplicantChannelBinding {
  return {
    id: row.id as ReplicantChannelBinding["id"],
    channelId: row.channel_id as ChannelId,
    replicantId: row.replicant_id as ReplicantId,
    behavior: row.behavior as ReplicantChannelBinding["behavior"],
    createdAt: row.created_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as MessageId,
    channelId: row.channel_id as ChannelId,
    replyToId: row.reply_to_id as MessageId | null,
    authorKind: row.author_kind as Message["authorKind"],
    authorUserId: row.author_user_id as UserId | null,
    authorReplicantId: row.author_replicant_id as ReplicantId | null,
    content: row.content as string,
    editedAt: row.edited_at as IsoTimestamp | null,
    deletedAt: row.deleted_at as IsoTimestamp | null,
    createdAt: row.created_at as IsoTimestamp,
  };
}

export class CategoryRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(category: Category): Category {
    connectionFor(this.database)
      .prepare(
        "INSERT INTO categories(id, workspace_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        category.id,
        category.workspaceId,
        requiredText(category.name, "category name", 120),
        category.position,
        category.createdAt,
      );
    return category;
  }

  list(workspaceId: WorkspaceId): Category[] {
    const rows = connectionFor(this.database)
      .prepare(
        "SELECT * FROM categories WHERE workspace_id = ? ORDER BY position, name",
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(mapCategory);
  }
}

export class ChannelRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(channel: Channel): Channel {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO channels(
          id, workspace_id, category_id, kind, slug, name, description, archived_at,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        channel.id,
        channel.workspaceId,
        channel.categoryId,
        channel.kind,
        requiredText(channel.slug, "channel slug", 64),
        requiredText(channel.name, "channel name", 120),
        optionalText(channel.description, "channel description", 2_000),
        channel.archivedAt,
        channel.createdBy,
        channel.createdAt,
        channel.updatedAt,
      );
    return channel;
  }

  get(id: ChannelId): Channel | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM channels WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapChannel(row);
  }

  list(workspaceId: WorkspaceId, includeArchived = false): Channel[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM channels
         WHERE workspace_id = ? AND (? = 1 OR archived_at IS NULL)
         ORDER BY name COLLATE NOCASE`,
      )
      .all(workspaceId, includeArchived ? 1 : 0) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapChannel);
  }

  markRead(
    channelId: ChannelId,
    userId: UserId,
    messageId: MessageId | null,
    now: IsoTimestamp,
  ): void {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO channel_reads(channel_id, user_id, last_read_message_id, last_read_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET
           last_read_message_id = excluded.last_read_message_id,
           last_read_at = excluded.last_read_at`,
      )
      .run(channelId, userId, messageId, now);
  }

  unreadCount(channelId: ChannelId, userId: UserId): number {
    const row = connectionFor(this.database)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages m
         LEFT JOIN channel_reads r ON r.channel_id = m.channel_id AND r.user_id = ?
         WHERE m.channel_id = ?
           AND m.deleted_at IS NULL
           AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)`,
      )
      .get(userId, channelId) as { count: number };
    return row.count;
  }
}

export class ReplicantRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(replicant: Replicant): Replicant {
    const relativeWorkspacePath = safeRelativePath(
      replicant.relativeWorkspacePath,
    );
    const relativeMemoryPath = safeDescendantPath(
      relativeWorkspacePath,
      replicant.relativeMemoryPath,
    );
    connectionFor(this.database)
      .prepare(
        `INSERT INTO replicants(
          id, workspace_id, slug, name, description, persona, default_harness, default_model,
          relative_workspace_path, relative_memory_path, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        replicant.id,
        replicant.workspaceId,
        requiredText(replicant.slug, "replicant slug", 64),
        requiredText(replicant.name, "replicant name", 120),
        optionalText(replicant.description, "replicant description", 2_000),
        requiredText(replicant.persona, "replicant persona", 50_000),
        requiredText(replicant.defaultHarness, "default harness", 80),
        replicant.defaultModel,
        relativeWorkspacePath,
        relativeMemoryPath,
        replicant.status,
        replicant.createdAt,
        replicant.updatedAt,
      );
    return replicant;
  }

  get(id: ReplicantId): Replicant | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM replicants WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapReplicant(row);
  }

  list(workspaceId: WorkspaceId, includeArchived = false): Replicant[] {
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM replicants
         WHERE workspace_id = ? AND (? = 1 OR status <> 'archived')
         ORDER BY name COLLATE NOCASE`,
      )
      .all(workspaceId, includeArchived ? 1 : 0) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapReplicant);
  }

  bind(binding: ReplicantChannelBinding): ReplicantChannelBinding {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO replicant_channel_bindings(
          id, channel_id, replicant_id, behavior, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, replicant_id) DO UPDATE SET
          behavior = excluded.behavior,
          updated_at = excluded.updated_at`,
      )
      .run(
        binding.id,
        binding.channelId,
        binding.replicantId,
        binding.behavior,
        binding.createdAt,
        binding.updatedAt,
      );
    return binding;
  }

  listBindings(channelId: ChannelId): ReplicantChannelBinding[] {
    const rows = connectionFor(this.database)
      .prepare(
        "SELECT * FROM replicant_channel_bindings WHERE channel_id = ? ORDER BY replicant_id",
      )
      .all(channelId) as Array<Record<string, unknown>>;
    return rows.map(mapBinding);
  }
}

export class MessageRepository {
  constructor(private readonly database: ReplicantDatabase) {}

  create(message: Message): Message {
    connectionFor(this.database)
      .prepare(
        `INSERT INTO messages(
          id, channel_id, reply_to_id, author_kind, author_user_id, author_replicant_id,
          content, edited_at, deleted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.channelId,
        message.replyToId,
        message.authorKind,
        message.authorUserId,
        message.authorReplicantId,
        requiredText(message.content, "message content", 100_000),
        message.editedAt,
        message.deletedAt,
        message.createdAt,
      );
    return message;
  }

  get(id: MessageId): Message | null {
    const row = connectionFor(this.database)
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapMessage(row);
  }

  list(
    channelId: ChannelId,
    options: { before?: IsoTimestamp; limit?: number } = {},
  ): Message[] {
    const before = options.before ?? "9999-12-31T23:59:59.999Z";
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND created_at < ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(channelId, before, cappedLimit(options.limit)) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapMessage);
  }

  edit(id: MessageId, content: string, now: IsoTimestamp): Message {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(requiredText(content, "message content", 100_000), now, id);
    if (result.changes !== 1)
      throw new Error("Message not found or already deleted");
    const updated = this.get(id);
    if (updated === null) throw new Error("Message disappeared during update");
    return updated;
  }

  softDelete(id: MessageId, now: IsoTimestamp): boolean {
    const result = connectionFor(this.database)
      .prepare(
        "UPDATE messages SET content = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(now, id);
    return result.changes === 1;
  }

  addTag(id: MessageId, tag: string): void {
    connectionFor(this.database)
      .prepare(
        "INSERT OR IGNORE INTO message_tags(message_id, tag) VALUES (?, ?)",
      )
      .run(id, requiredText(tag, "tag", 64));
  }

  search(channelId: ChannelId, term: string, limit?: number): Message[] {
    const escaped = requiredText(term, "search term", 200)
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const rows = connectionFor(this.database)
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND deleted_at IS NULL AND content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(channelId, `%${escaped}%`, cappedLimit(limit)) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapMessage);
  }
}
