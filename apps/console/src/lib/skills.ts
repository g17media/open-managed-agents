export function skillDisplayName(skill: {
  id: string;
  display_title?: string | null;
  name?: string | null;
}): string {
  return skill.display_title?.trim() || skill.name?.trim() || skill.id;
}
