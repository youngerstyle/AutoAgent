export const TEAM_STAFFING_SCHEMA_REF = "team-staffing-v1";

export interface StaffingMemberProposal {
  profileId: string;
  responsibility: string;
  rationale: string;
}

export interface RecruitmentRequest {
  capabilities: string[];
  reason: string;
}

export type TeamStaffingOutcome =
  | {
      status: "staffed";
      members: StaffingMemberProposal[];
      recruitmentRequests: [];
    }
  | {
      status: "recruitment_required";
      members: StaffingMemberProposal[];
      recruitmentRequests: RecruitmentRequest[];
    };

export const TEAM_STAFFING_OUTCOME_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status", "members", "recruitmentRequests"],
  properties: {
    status: {
      type: "string",
      enum: ["staffed", "recruitment_required"],
    },
    members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["profileId", "responsibility", "rationale"],
        properties: {
          profileId: { type: "string", minLength: 1 },
          responsibility: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
    recruitmentRequests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capabilities", "reason"],
        properties: {
          capabilities: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export function parseTeamStaffingOutcome(value: unknown): TeamStaffingOutcome {
  if (!isRecord(value)) throw new Error("组队提案必须是对象");
  const status = value.status;
  if (status !== "staffed" && status !== "recruitment_required") {
    throw new Error("组队提案 status 必须是 staffed 或 recruitment_required");
  }
  if (!Array.isArray(value.members) || !Array.isArray(value.recruitmentRequests)) {
    throw new Error("组队提案缺少 members 或 recruitmentRequests");
  }
  const members = value.members.map((member, index) => {
    if (!isRecord(member)) throw new Error(`第 ${index + 1} 个成员不是对象`);
    return {
      profileId: requiredText(member.profileId, `第 ${index + 1} 个成员缺少 profileId`),
      responsibility: requiredText(member.responsibility, `第 ${index + 1} 个成员缺少 responsibility`),
      rationale: requiredText(member.rationale, `第 ${index + 1} 个成员缺少 rationale`),
    };
  });
  const recruitmentRequests = value.recruitmentRequests.map((request, index) => {
    if (!isRecord(request) || !Array.isArray(request.capabilities)) {
      throw new Error(`第 ${index + 1} 个招聘请求无效`);
    }
    const capabilities = request.capabilities.map((capability) =>
      requiredText(capability, `第 ${index + 1} 个招聘请求包含空能力`),
    );
    if (!capabilities.length) throw new Error(`第 ${index + 1} 个招聘请求没有能力要求`);
    return {
      capabilities,
      reason: requiredText(request.reason, `第 ${index + 1} 个招聘请求缺少原因`),
    };
  });
  if (new Set(members.map((member) => member.profileId)).size !== members.length) {
    throw new Error("同一人才档案不能在一个组队提案中重复");
  }
  if (status === "staffed") {
    if (!members.length) throw new Error("staffed 提案至少需要一名成员");
    if (recruitmentRequests.length) throw new Error("staffed 提案不能同时包含招聘请求");
    return { status, members, recruitmentRequests: [] };
  }
  if (!recruitmentRequests.length) {
    throw new Error("recruitment_required 提案必须说明人才缺口");
  }
  return { status, members, recruitmentRequests };
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
