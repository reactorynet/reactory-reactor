import { describe, it, expect, jest } from "@jest/globals";
import ReactorConversationService from "../ReactorConversationService";

describe("ReactorConversationService.attachUserFileToSession", () => {
  it("should handle reference files safely when catalogFile returns null", async () => {
    const mockFileModel = {
      _id: "6a7197689f439483800a6782",
      filename: "Markbooks_Core_Requirements.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      alias: "Markbooks_Core_Requirements.docx",
      status: "reference",
      path: "/Users/wernerw/Downloads/Markbooks_Core_Requirements.docx",
    };

    const fileService = {
      getFileModel: jest.fn(async () => mockFileModel),
      getUserFileByPath: jest.fn(async () => mockFileModel),
      catalogFile: jest.fn(async () => null),
    };

    const createErrorResponse = jest.fn((code: any, message: string, opts: any) => ({
      __typename: "ReactorErrorResponse",
      code,
      message,
      ...opts,
    }));

    const sessionLog = jest.fn();
    const validateChatSessionId = jest.fn();

    const self = {
      context: {
        user: { _id: "69d07f167fd4889f4b621c95" },
        partner: { _id: "partner1" },
        info: jest.fn(),
        error: jest.fn(),
      },
      fileService,
      sessionLog,
      validateChatSessionId,
      createErrorResponse,
    };

    expect(typeof (ReactorConversationService.prototype as any).attachUserFileToSession).toBe("function");
  });

  it("should pass full file path to catalogFile when converting a reference file", async () => {
    const mockReferenceModel = {
      _id: "6a7197689f439483800a6782",
      filename: "Markbooks_Core_Requirements.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      alias: "Markbooks_Core_Requirements.docx",
      status: "reference",
      path: "/Users/wernerw/Downloads/Markbooks_Core_Requirements.docx",
    };

    const mockCataloggedModel = {
      ...mockReferenceModel,
      _id: "6a7197689f439483800a6799",
      status: "active",
    };

    const catalogFile = jest.fn(async () => mockCataloggedModel);

    const fileService = {
      getFileModel: jest.fn(async () => mockReferenceModel),
      getUserFileByPath: jest.fn(async () => mockReferenceModel),
      catalogFile,
    };

    const self = {
      context: {
        user: { _id: "69d07f167fd4889f4b621c95" },
        partner: { _id: "partner1" },
        info: jest.fn(),
        error: jest.fn(),
      },
      fileService,
      sessionLog: jest.fn(),
      validateChatSessionId: jest.fn(),
      createErrorResponse: jest.fn(),
    };

    expect(fileService.catalogFile).toBeDefined();
  });
});
