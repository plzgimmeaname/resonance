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

// a track in a playlist, position is its index in the playlist (local files and episodes take a slot too)
export interface PlaylistTrack extends Track {
  position: number;
}

export interface PlaylistInfo {
  id: string;
  name: string;
  image?: string;
  tracks: number;
  owned: boolean;
  collaborative: boolean;
  public: boolean | null;
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
