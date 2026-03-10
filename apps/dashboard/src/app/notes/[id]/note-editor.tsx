"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MarkdownContent } from "@/components/ui/markdown";
import { updateNote } from "../actions";
import { ArrowLeft, Save, Pencil, X } from "lucide-react";
import type { Note } from "@schema";

export function NoteEditor({ note }: { note: Note }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [topic, setTopic] = useState(note.topic);
  const [content, setContent] = useState(note.content);
  const [category, setCategory] = useState(note.category);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await updateNote(note.id, { topic, content, category });
    setSaving(false);
    setEditing(false);
    router.refresh();
  }

  function handleCancel() {
    setTopic(note.topic);
    setContent(note.content);
    setCategory(note.category);
    setEditing(false);
  }

  return (
    <>
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          {editing ? (
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="text-lg font-semibold border-0 px-0 focus-visible:ring-0 shadow-none"
            />
          ) : (
            <h1 className="text-lg font-semibold">{topic}</h1>
          )}
        </div>
        <Badge variant="secondary">{editing ? category : note.category}</Badge>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              <X className="h-4 w-4" /> Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving} size="sm">
              <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        )}
      </div>

      {editing && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">Category</label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
        </div>
      )}

      <div>
        {editing ? (
          <>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex min-h-[calc(100vh-280px)] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono"
            />
          </>
        ) : (
          <MarkdownContent content={content} className="max-w-3xl" />
        )}
      </div>
    </>
  );
}
