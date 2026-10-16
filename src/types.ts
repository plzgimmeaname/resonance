export type Range = "short" | "medium" | "long";

export interface Artist {
  id: string;
  name: string;
  image?: string;
  genres: string[];
  url?: string;
}

export interface Track {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  artistIds: string[];
  album: string;
  image?: string;
  url?: string;
  previewUrl?: string;
  durationMs?: number;
  playedAt?: string;
}

export interface Release {
  id: string;
  name: string;
  artists: string[];
  image?: string;
  url?: string;
  releaseDate: string;
  kind: string;
}
