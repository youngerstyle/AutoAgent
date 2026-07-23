import { describe, expect, it } from "vitest";
import { paginateTeamDirectory } from "../../src/client/team-directory";

describe("team directory", () => {
  it("keeps a large team bounded to ten members per page", () => {
    const members = Array.from({ length: 25 }, (_, index) => `member-${index + 1}`);

    expect(paginateTeamDirectory(members, 0, 10)).toEqual({
      items: members.slice(0, 10),
      page: 0,
      pageCount: 3,
      total: 25
    });
    expect(paginateTeamDirectory(members, 2, 10)).toEqual({
      items: members.slice(20),
      page: 2,
      pageCount: 3,
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
