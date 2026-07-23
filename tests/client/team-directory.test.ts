import { describe, expect, it } from "vitest";
import { paginateTeamDirectory, TEAM_DIRECTORY_PAGE_SIZE } from "../../src/client/team-directory";

describe("team directory", () => {
  it("keeps a large team bounded to the visible directory page", () => {
    const members = Array.from({ length: 25 }, (_, index) => `member-${index + 1}`);

    expect(paginateTeamDirectory(members, 0, TEAM_DIRECTORY_PAGE_SIZE)).toEqual({
      items: members.slice(0, 8),
      page: 0,
      pageCount: 4,
      total: 25
    });
    expect(paginateTeamDirectory(members, 3, TEAM_DIRECTORY_PAGE_SIZE)).toEqual({
      items: members.slice(24),
      page: 3,
      pageCount: 4,
      total: 25
    });
  });

  it("clamps pages after a search narrows the result set", () => {
    expect(paginateTeamDirectory(["开发"], 4, 10)).toEqual({
      items: ["开发"],
      page: 0,
      pageCount: 1,
      total: 1
    });
  });
});
