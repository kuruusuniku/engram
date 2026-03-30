/**
 * SessionManager - Session lifecycle management
 *
 * Handles:
 * - Auto-creation of sessions on first memory_save
 * - Session end detection (timeout-based)
 * - Triggering MEMORY.md update on session end
 */

import { v4 as uuidv4 } from "uuid";
import type { StorageAdapter } from "./storage/adapter.js";
import type { Session } from "./storage/types.js";
import type { MemoryIndex } from "./memory-index.js";

export interface SessionManagerConfig {
  /** Tenant ID */
  tenantId: string;
  /** Session timeout in milliseconds (default: 30 minutes) */
  sessionTimeoutMs?: number;
  /** Whether to auto-update MEMORY.md on session end (default: true) */
  autoUpdateIndex?: boolean;
}

export class SessionManager {
  private config: SessionManagerConfig;
  private adapter: StorageAdapter;
  private memoryIndex: MemoryIndex | null;
  private currentSessionId: string | null = null;
  private lastActivityTime: number = 0;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    adapter: StorageAdapter,
    memoryIndex: MemoryIndex | null,
    config: SessionManagerConfig
  ) {
    this.adapter = adapter;
    this.memoryIndex = memoryIndex;
    this.config = config;
  }

  /**
   * Get or create a session for the current interaction.
   * Auto-detects if the current session has timed out.
   */
  async getOrCreateSession(project?: string): Promise<Session> {
    const now = Date.now();
    const timeoutMs = this.config.sessionTimeoutMs ?? 30 * 60 * 1000;

    // Check if current session is still active
    if (this.currentSessionId && now - this.lastActivityTime < timeoutMs) {
      this.lastActivityTime = now;
      this.resetTimeout();

      const session = await this.adapter.getSession(this.currentSessionId);
      if (session && !session.ended_at) {
        return session;
      }
    }

    // End previous session if exists
    if (this.currentSessionId) {
      await this.endCurrentSession();
    }

    // Create new session
    const session = await this.adapter.createSession({
      session_id: uuidv4(),
      tenant_id: this.config.tenantId,
      project,
    });

    this.currentSessionId = session.session_id;
    this.lastActivityTime = now;
    this.resetTimeout();

    return session;
  }

  /**
   * Record activity (called on each tool invocation)
   */
  recordActivity(): void {
    this.lastActivityTime = Date.now();
    this.resetTimeout();
  }

  /**
   * End the current session explicitly
   */
  async endCurrentSession(): Promise<void> {
    if (this.currentSessionId) {
      try {
        await this.adapter.endSession(this.currentSessionId);
      } catch {
        // Session might already be ended
      }

      // Auto-update MEMORY.md if configured
      if (this.config.autoUpdateIndex !== false && this.memoryIndex) {
        try {
          await this.memoryIndex.update();
        } catch (error) {
          console.error("[session-manager] Failed to update MEMORY.md:", error);
        }
      }

      this.currentSessionId = null;
    }

    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  /**
   * Get the current session ID (null if no active session)
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Reset the inactivity timeout
   */
  private resetTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }

    const timeoutMs = this.config.sessionTimeoutMs ?? 30 * 60 * 1000;
    this.timeoutHandle = setTimeout(async () => {
      await this.endCurrentSession();
    }, timeoutMs);

    // Ensure the timeout doesn't prevent process exit
    if (this.timeoutHandle && typeof this.timeoutHandle === "object" && "unref" in this.timeoutHandle) {
      this.timeoutHandle.unref();
    }
  }

  /**
   * Cleanup: end session and clear timeouts
   */
  async cleanup(): Promise<void> {
    await this.endCurrentSession();
  }
}
