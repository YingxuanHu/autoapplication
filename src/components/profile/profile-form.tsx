"use client";

import { type ReactNode, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, LoaderCircle } from "lucide-react";

import { saveProfile } from "@/app/profile/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  makeEmptyContact,
  makeEmptyEducation,
  makeEmptyExperience,
  makeEmptyProject,
  makeEmptySkill,
  type ProfileContact,
  type ProfileEducation,
  type ProfileExperience,
  type ProfileProject,
  type ProfileSkill,
} from "@/lib/profile";

type ProfileFormProps = {
  initialValues: {
    headline: string;
    summary: string;
    contact: ProfileContact;
    skills: ProfileSkill[];
    educations: ProfileEducation[];
    experiences: ProfileExperience[];
    projects: ProfileProject[];
  };
};

type ProfileSectionId =
  | "overview"
  | "contact"
  | "skills"
  | "experience"
  | "education"
  | "projects";

type ProfileSectionProps = {
  id: ProfileSectionId;
  title: string;
  badge?: string;
  activeSection: ProfileSectionId | null;
  setActiveSection: (value: ProfileSectionId | null) => void;
  children: ReactNode;
};

type SaveButtonProps = {
  dirty: boolean;
  saved: boolean;
};

function SaveButton({ dirty, saved }: SaveButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button className="sm:min-w-40" type="submit" disabled={pending || !dirty} variant={dirty ? "default" : "secondary"}>
      {pending ? (
        <>
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          Saving...
        </>
      ) : saved ? (
        <>
          <CheckCircle2 className="h-3.5 w-3.5" />
          Saved
        </>
      ) : (
        "Save profile"
      )}
    </Button>
  );
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function countFilledContactFields(contact: ProfileContact) {
  return Object.values(contact).filter((value) => value.trim().length > 0).length;
}

function countFilledSkills(skills: ProfileSkill[]) {
  return skills.filter((entry) => entry.name.trim().length > 0).length;
}

function countFilledExperiences(experiences: ProfileExperience[]) {
  return experiences.filter(
    (entry) =>
      entry.title.trim().length > 0 ||
      entry.company.trim().length > 0 ||
      entry.description.trim().length > 0
  ).length;
}

function countFilledEducations(educations: ProfileEducation[]) {
  return educations.filter(
    (entry) =>
      entry.school.trim().length > 0 ||
      entry.degree.trim().length > 0 ||
      entry.description.trim().length > 0
  ).length;
}

function countFilledProjects(projects: ProfileProject[]) {
  return projects.filter(
    (entry) =>
      entry.name.trim().length > 0 ||
      entry.title.trim().length > 0 ||
      entry.description.trim().length > 0
  ).length;
}

function formatCountBadge(count: number, singular: string, plural?: string) {
  if (count === 0) {
    return "Empty";
  }

  return `${count} ${pluralize(count, singular, plural)}`;
}

function ProfileSection({
  id,
  title,
  badge,
  activeSection,
  setActiveSection,
  children,
}: ProfileSectionProps) {
  const isOpen = activeSection === id;

  return (
    <section className="border-t border-border/70 py-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-4">
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => setActiveSection(isOpen ? null : id)}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {title}
            </h3>
            {badge ? (
              <span className="text-xs text-muted-foreground">{badge}</span>
            ) : null}
          </div>
        </button>
        <button
          className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          onClick={() => setActiveSection(isOpen ? null : id)}
          type="button"
        >
          {isOpen ? "Collapse" : "Expand"}
        </button>
      </div>

      <div className={isOpen ? "mt-4" : "hidden"}>{children}</div>
    </section>
  );
}

function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label className="text-xs font-medium text-muted-foreground" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

function trimmed(value: string) {
  return value.trim();
}

function normalizeSkillsSnapshot(skills: ProfileSkill[]) {
  return skills
    .map((entry) => ({ name: trimmed(entry.name) }))
    .filter((entry) => entry.name.length > 0);
}

function normalizeExperiencesSnapshot(experiences: ProfileExperience[]) {
  return experiences
    .map((entry) => ({
      title: trimmed(entry.title),
      time: trimmed(entry.time),
      company: trimmed(entry.company),
      location: trimmed(entry.location),
      description: entry.description.trim(),
    }))
    .filter(
      (entry) =>
        entry.title.length > 0 ||
        entry.company.length > 0 ||
        entry.description.length > 0 ||
        entry.time.length > 0 ||
        entry.location.length > 0
    );
}

function normalizeEducationsSnapshot(educations: ProfileEducation[]) {
  return educations
    .map((entry) => ({
      school: trimmed(entry.school),
      degree: trimmed(entry.degree),
      time: trimmed(entry.time),
      location: trimmed(entry.location),
      description: entry.description.trim(),
    }))
    .filter(
      (entry) =>
        entry.school.length > 0 ||
        entry.degree.length > 0 ||
        entry.description.length > 0 ||
        entry.time.length > 0 ||
        entry.location.length > 0
    );
}

function normalizeProjectsSnapshot(projects: ProfileProject[]) {
  return projects
    .map((entry) => ({
      name: trimmed(entry.name),
      title: trimmed(entry.title),
      time: trimmed(entry.time),
      location: trimmed(entry.location),
      description: entry.description.trim(),
    }))
    .filter(
      (entry) =>
        entry.name.length > 0 ||
        entry.title.length > 0 ||
        entry.description.length > 0 ||
        entry.time.length > 0 ||
        entry.location.length > 0
    );
}

function normalizeContactSnapshot(contact: ProfileContact) {
  return {
    fullName: trimmed(contact.fullName),
    email: trimmed(contact.email),
    phone: trimmed(contact.phone),
    location: trimmed(contact.location),
    linkedInUrl: trimmed(contact.linkedInUrl),
    githubUrl: trimmed(contact.githubUrl),
    portfolioUrl: trimmed(contact.portfolioUrl),
  };
}

function serializeProfileSnapshot(input: {
  headline: string;
  summary: string;
  contact: ProfileContact;
  skills: ProfileSkill[];
  educations: ProfileEducation[];
  experiences: ProfileExperience[];
  projects: ProfileProject[];
}) {
  return JSON.stringify({
    headline: trimmed(input.headline),
    summary: input.summary.trim(),
    contact: normalizeContactSnapshot(input.contact),
    skills: normalizeSkillsSnapshot(input.skills),
    educations: normalizeEducationsSnapshot(input.educations),
    experiences: normalizeExperiencesSnapshot(input.experiences),
    projects: normalizeProjectsSnapshot(input.projects),
  });
}

export function ProfileForm({ initialValues }: ProfileFormProps) {
  const initialState = { error: null, success: null };
  const [state, formAction] = useActionState(saveProfile, initialState);

  const [activeSection, setActiveSection] = useState<ProfileSectionId | null>("overview");
  const [headline, setHeadline] = useState(initialValues.headline);
  const [summary, setSummary] = useState(initialValues.summary);
  const [contact, setContact] = useState<ProfileContact>(initialValues.contact ?? makeEmptyContact());
  const [skills, setSkills] = useState<ProfileSkill[]>(
    initialValues.skills.length > 0 ? initialValues.skills : [makeEmptySkill()]
  );
  const [educations, setEducations] = useState<ProfileEducation[]>(
    initialValues.educations.length > 0 ? initialValues.educations : [makeEmptyEducation()]
  );
  const [experiences, setExperiences] = useState<ProfileExperience[]>(
    initialValues.experiences.length > 0 ? initialValues.experiences : [makeEmptyExperience()]
  );
  const [projects, setProjects] = useState<ProfileProject[]>(
    initialValues.projects.length > 0 ? initialValues.projects : [makeEmptyProject()]
  );

  const skillsJson = useMemo(() => JSON.stringify(skills), [skills]);
  const contactJson = useMemo(() => JSON.stringify(contact), [contact]);
  const educationsJson = useMemo(() => JSON.stringify(educations), [educations]);
  const experiencesJson = useMemo(() => JSON.stringify(experiences), [experiences]);
  const projectsJson = useMemo(() => JSON.stringify(projects), [projects]);
  const currentSnapshot = useMemo(
    () =>
      serializeProfileSnapshot({
        headline,
        summary,
        contact,
        skills,
        educations,
        experiences,
        projects,
      }),
    [contact, educations, experiences, headline, projects, skills, summary]
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    serializeProfileSnapshot({
      headline: initialValues.headline,
      summary: initialValues.summary,
      contact: initialValues.contact ?? makeEmptyContact(),
      skills: initialValues.skills.length > 0 ? initialValues.skills : [makeEmptySkill()],
      educations:
        initialValues.educations.length > 0
          ? initialValues.educations
          : [makeEmptyEducation()],
      experiences:
        initialValues.experiences.length > 0
          ? initialValues.experiences
          : [makeEmptyExperience()],
      projects: initialValues.projects.length > 0 ? initialValues.projects : [makeEmptyProject()],
    })
  );
  const submittedSnapshotRef = useRef<string | null>(null);
  const isDirty = currentSnapshot !== savedSnapshot;

  useEffect(() => {
    if (!state.success || !submittedSnapshotRef.current) {
      return;
    }

    setSavedSnapshot(submittedSnapshotRef.current);
    submittedSnapshotRef.current = null;
  }, [state]);

  function updateContact(key: keyof ProfileContact, value: string) {
    setContact((current) => ({ ...current, [key]: value }));
  }

  function updateSkill(index: number, value: string) {
    setSkills((current) => current.map((entry, i) => (i === index ? { ...entry, name: value } : entry)));
  }

  function updateEducation(index: number, key: keyof ProfileEducation, value: string) {
    setEducations((current) =>
      current.map((entry, i) => (i === index ? { ...entry, [key]: value } : entry))
    );
  }

  function updateExperience(index: number, key: keyof ProfileExperience, value: string) {
    setExperiences((current) =>
      current.map((entry, i) => (i === index ? { ...entry, [key]: value } : entry))
    );
  }

  function updateProject(index: number, key: keyof ProfileProject, value: string) {
    setProjects((current) =>
      current.map((entry, i) => (i === index ? { ...entry, [key]: value } : entry))
    );
  }

  return (
    <form
      action={formAction}
      className="mt-4"
      onSubmit={() => {
        submittedSnapshotRef.current = currentSnapshot;
      }}
    >
      <input type="hidden" name="contactJson" value={contactJson} />
      <input type="hidden" name="skillsJson" value={skillsJson} />
      <input type="hidden" name="educationsJson" value={educationsJson} />
      <input type="hidden" name="experiencesJson" value={experiencesJson} />
      <input type="hidden" name="projectsJson" value={projectsJson} />

      <ProfileSection
        activeSection={activeSection}
        id="overview"
        setActiveSection={setActiveSection}
        title="Overview"
      >
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="headline">Headline</FieldLabel>
            <Input
              id="headline"
              maxLength={200}
              name="headline"
              onChange={(event) => setHeadline(event.target.value)}
              placeholder="Role focus and specialization"
              value={headline}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="summary">Summary</FieldLabel>
            <Textarea
              className="min-h-[96px] resize-y"
              id="summary"
              name="summary"
              onChange={(event) => setSummary(event.target.value)}
              placeholder="2-4 sentence professional summary"
              rows={4}
              value={summary}
            />
          </div>
        </div>
      </ProfileSection>

      <ProfileSection
        activeSection={activeSection}
        badge={formatCountBadge(countFilledContactFields(contact), "field")}
        id="contact"
        setActiveSection={setActiveSection}
        title="Contact"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="contact-full-name">Full name</FieldLabel>
            <Input
              id="contact-full-name"
              onChange={(event) => updateContact("fullName", event.target.value)}
              placeholder="First Last"
              type="text"
              value={contact.fullName}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="contact-email">Email</FieldLabel>
            <Input
              id="contact-email"
              onChange={(event) => updateContact("email", event.target.value)}
              placeholder="name@example.com"
              type="email"
              value={contact.email}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="contact-phone">Phone</FieldLabel>
            <Input
              id="contact-phone"
              onChange={(event) => updateContact("phone", event.target.value)}
              placeholder="+CountryCode Number"
              type="text"
              value={contact.phone}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="contact-location">Location</FieldLabel>
            <Input
              id="contact-location"
              onChange={(event) => updateContact("location", event.target.value)}
              placeholder="City, Region, Country"
              type="text"
              value={contact.location}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="contact-linkedin">LinkedIn URL</FieldLabel>
            <Input
              id="contact-linkedin"
              onChange={(event) => updateContact("linkedInUrl", event.target.value)}
              placeholder="https://linkedin.com/in/your-id"
              type="url"
              value={contact.linkedInUrl}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="contact-github">GitHub URL</FieldLabel>
            <Input
              id="contact-github"
              onChange={(event) => updateContact("githubUrl", event.target.value)}
              placeholder="https://github.com/your-id"
              type="url"
              value={contact.githubUrl}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <FieldLabel htmlFor="contact-portfolio">Portfolio URL</FieldLabel>
            <Input
              id="contact-portfolio"
              onChange={(event) => updateContact("portfolioUrl", event.target.value)}
              placeholder="https://your-portfolio-url"
              type="url"
              value={contact.portfolioUrl}
            />
          </div>
        </div>
      </ProfileSection>

      <ProfileSection
        activeSection={activeSection}
        badge={formatCountBadge(countFilledSkills(skills), "skill")}
        id="skills"
        setActiveSection={setActiveSection}
        title="Skills"
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {skills.map((skill, index) => (
            <div
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
              key={`skill-${index}`}
            >
              <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0">
                <label className="sr-only" htmlFor={`skill-${index}`}>
                  Skill {index + 1}
                </label>
                <input
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  id={`skill-${index}`}
                  onChange={(event) => updateSkill(index, event.target.value)}
                  placeholder="Skill name"
                  type="text"
                  value={skill.name}
                />
              </div>
              {skills.length > 1 ? (
                <button
                  aria-label={`Remove skill ${index + 1}`}
                  className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  onClick={() =>
                    setSkills((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                  type="button"
                >
                  Remove
                </button>
              ) : (
                <span aria-hidden="true" className="w-12" />
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            className="text-sm font-semibold text-foreground underline underline-offset-2"
            onClick={() => setSkills((current) => [...current, makeEmptySkill()])}
            type="button"
          >
            + Add skill
          </button>
        </div>
      </ProfileSection>

      <ProfileSection
        activeSection={activeSection}
        badge={formatCountBadge(countFilledExperiences(experiences), "entry", "entries")}
        id="experience"
        setActiveSection={setActiveSection}
        title="Experience"
      >
        <div className="grid gap-3">
          {experiences.map((entry, index) => (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3" key={`experience-${index}`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">Experience {index + 1}</p>
                {experiences.length > 1 ? (
                  <button
                    className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() =>
                      setExperiences((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`experience-title-${index}`}>Title</FieldLabel>
                  <Input
                    id={`experience-title-${index}`}
                    onChange={(event) => updateExperience(index, "title", event.target.value)}
                    placeholder="Job title"
                    type="text"
                    value={entry.title}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`experience-time-${index}`}>Time</FieldLabel>
                  <Input
                    id={`experience-time-${index}`}
                    onChange={(event) => updateExperience(index, "time", event.target.value)}
                    placeholder="MM-YYYY - MM-YYYY"
                    type="text"
                    value={entry.time}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`experience-company-${index}`}>Company</FieldLabel>
                  <Input
                    id={`experience-company-${index}`}
                    onChange={(event) => updateExperience(index, "company", event.target.value)}
                    placeholder="Company name"
                    type="text"
                    value={entry.company}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`experience-location-${index}`}>Location</FieldLabel>
                  <Input
                    id={`experience-location-${index}`}
                    onChange={(event) => updateExperience(index, "location", event.target.value)}
                    placeholder="City, Region"
                    type="text"
                    value={entry.location}
                  />
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <FieldLabel htmlFor={`experience-description-${index}`}>Description</FieldLabel>
                <Textarea
                  id={`experience-description-${index}`}
                  onChange={(event) => updateExperience(index, "description", event.target.value)}
                  placeholder="Key responsibilities and measurable impact"
                  rows={5}
                  value={entry.description}
                  className="min-h-[110px] resize-y"
                />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            className="text-sm font-semibold text-foreground underline underline-offset-2"
            onClick={() => setExperiences((current) => [...current, makeEmptyExperience()])}
            type="button"
          >
            + Add experience
          </button>
        </div>
      </ProfileSection>

      <ProfileSection
        activeSection={activeSection}
        badge={formatCountBadge(countFilledEducations(educations), "entry", "entries")}
        id="education"
        setActiveSection={setActiveSection}
        title="Education"
      >
        <div className="grid gap-3">
          {educations.map((entry, index) => (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3" key={`education-${index}`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">Education {index + 1}</p>
                {educations.length > 1 ? (
                  <button
                    className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() =>
                      setEducations((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`education-school-${index}`}>School</FieldLabel>
                  <Input
                    id={`education-school-${index}`}
                    onChange={(event) => updateEducation(index, "school", event.target.value)}
                    placeholder="School name"
                    type="text"
                    value={entry.school}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`education-degree-${index}`}>Degree</FieldLabel>
                  <Input
                    id={`education-degree-${index}`}
                    onChange={(event) => updateEducation(index, "degree", event.target.value)}
                    placeholder="Degree and program"
                    type="text"
                    value={entry.degree}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`education-time-${index}`}>Time</FieldLabel>
                  <Input
                    id={`education-time-${index}`}
                    onChange={(event) => updateEducation(index, "time", event.target.value)}
                    placeholder="MM-YYYY - MM-YYYY"
                    type="text"
                    value={entry.time}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`education-location-${index}`}>Location</FieldLabel>
                  <Input
                    id={`education-location-${index}`}
                    onChange={(event) => updateEducation(index, "location", event.target.value)}
                    placeholder="City, Region"
                    type="text"
                    value={entry.location}
                  />
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <FieldLabel htmlFor={`education-description-${index}`}>Description</FieldLabel>
                <Textarea
                  id={`education-description-${index}`}
                  onChange={(event) => updateEducation(index, "description", event.target.value)}
                  placeholder="Relevant coursework, honors, and activities"
                  rows={5}
                  value={entry.description}
                  className="min-h-[110px] resize-y"
                />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            className="text-sm font-semibold text-foreground underline underline-offset-2"
            onClick={() => setEducations((current) => [...current, makeEmptyEducation()])}
            type="button"
          >
            + Add education
          </button>
        </div>
      </ProfileSection>

      <ProfileSection
        activeSection={activeSection}
        badge={formatCountBadge(countFilledProjects(projects), "entry", "entries")}
        id="projects"
        setActiveSection={setActiveSection}
        title="Projects"
      >
        <div className="grid gap-3">
          {projects.map((entry, index) => (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3" key={`project-${index}`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">Project {index + 1}</p>
                {projects.length > 1 ? (
                  <button
                    className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() =>
                      setProjects((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`project-name-${index}`}>Name</FieldLabel>
                  <Input
                    id={`project-name-${index}`}
                    onChange={(event) => updateProject(index, "name", event.target.value)}
                    placeholder="Project name"
                    type="text"
                    value={entry.name}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`project-title-${index}`}>Title</FieldLabel>
                  <Input
                    id={`project-title-${index}`}
                    onChange={(event) => updateProject(index, "title", event.target.value)}
                    placeholder="Role or subtitle"
                    type="text"
                    value={entry.title}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`project-time-${index}`}>Time</FieldLabel>
                  <Input
                    id={`project-time-${index}`}
                    onChange={(event) => updateProject(index, "time", event.target.value)}
                    placeholder="MM-YYYY - MM-YYYY"
                    type="text"
                    value={entry.time}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor={`project-location-${index}`}>Location</FieldLabel>
                  <Input
                    id={`project-location-${index}`}
                    onChange={(event) => updateProject(index, "location", event.target.value)}
                    placeholder="City, Region"
                    type="text"
                    value={entry.location}
                  />
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                <FieldLabel htmlFor={`project-description-${index}`}>Description</FieldLabel>
                <Textarea
                  id={`project-description-${index}`}
                  onChange={(event) => updateProject(index, "description", event.target.value)}
                  placeholder="What you built, how it worked, and the results"
                  rows={5}
                  value={entry.description}
                  className="min-h-[110px] resize-y"
                />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            className="text-sm font-semibold text-foreground underline underline-offset-2"
            onClick={() => setProjects((current) => [...current, makeEmptyProject()])}
            type="button"
          >
            + Add project
          </button>
        </div>
      </ProfileSection>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border/70 pt-4">
        <SaveButton dirty={isDirty} saved={!isDirty && Boolean(state.success)} />
        <p className="text-xs text-muted-foreground">
          {isDirty ? "Unsaved changes" : state.success ? "Profile saved" : "No changes"}
        </p>
        {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      </div>
    </form>
  );
}
