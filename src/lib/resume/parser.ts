import { PDFParse } from "pdf-parse";

const COMMON_SKILLS = [
  "javascript", "typescript", "python", "java", "c++", "c#", "go", "rust",
  "ruby", "php", "swift", "kotlin", "scala", "r", "sql",
  "react", "angular", "vue", "svelte", "next.js", "nuxt", "node.js",
  "express", "django", "flask", "spring boot", "rails", "laravel", ".net",
  "aws", "azure", "gcp", "docker", "kubernetes", "terraform", "ansible",
  "jenkins", "github actions", "ci/cd", "git",
  "rest api", "graphql", "grpc", "microservices", "serverless",
  "postgresql", "mysql", "mongodb", "redis", "elasticsearch", "dynamodb",
  "html", "css", "tailwind", "sass", "webpack", "vite",
  "machine learning", "deep learning", "nlp", "computer vision", "tensorflow",
  "pytorch", "pandas", "numpy",
  "agile", "scrum", "kanban", "jira", "confluence",
  "figma", "sketch", "adobe xd",
  "linux", "nginx", "apache",
  "data analysis", "data engineering", "etl",
  "project management", "product management", "leadership",
  "communication", "problem solving", "teamwork",
];

export async function parseResumePdf(
  buffer: Buffer,
): Promise<{ text: string; skills: string[] }> {
  const pdf = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await pdf.getText();
  const text = result.text;

  const textLower = text.toLowerCase();
  const skills = COMMON_SKILLS.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    return regex.test(textLower);
  });

  await pdf.destroy();

  return { text, skills };
}
