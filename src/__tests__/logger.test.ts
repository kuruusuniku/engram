import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, createLogger, type ModuleLogger } from "../logger.js";

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.configure({ enabled: true, level: "debug", format: "text" });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    logger.configure({ level: "info", format: "text", enabled: true });
  });

  it("should create a module logger", () => {
    const log = createLogger("test-module");
    expect(log).toBeDefined();
  });

  it("should output to stderr", () => {
    const log = createLogger("test");
    log.info("Hello world");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("[INFO]");
    expect(output).toContain("[test]");
    expect(output).toContain("Hello world");
  });

  it("should respect log level", () => {
    logger.configure({ level: "warn" });
    const log = createLogger("test");

    log.debug("debug msg");
    log.info("info msg");
    expect(stderrSpy).not.toHaveBeenCalled();

    log.warn("warn msg");
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    log.error("error msg");
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it("should support JSON format", () => {
    logger.configure({ format: "json" });
    const log = createLogger("test");

    log.info("test message", { key: "value" });

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("test");
    expect(parsed.message).toBe("test message");
    expect(parsed.data).toEqual({ key: "value" });
  });

  it("should include data in text format", () => {
    const log = createLogger("test");
    log.info("with data", { count: 42 });
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('"count":42');
  });

  it("should not log when disabled", () => {
    logger.configure({ enabled: false });
    const log = createLogger("test");
    log.error("should not appear");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("should support all log levels", () => {
    const log = createLogger("test");
    log.debug("debug");
    log.info("info");
    log.warn("warn");
    log.error("error");
    expect(stderrSpy).toHaveBeenCalledTimes(4);
  });
});
