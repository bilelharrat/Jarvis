"""
MediaSummarizer Module: Video content summarization and transcript extraction.

Provides APIs for:
- Summarizing video content from URLs
- Extracting key frames and highlights
- Transcribing video audio
"""

from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime
from pathlib import Path
import json


@dataclass
class Keyframe:
    """Extracted key frame from video."""
    timestamp_seconds: float
    title: str
    description: str
    thumbnail_url: Optional[str] = None
    importance: float = 0.5  # 0.0-1.0


@dataclass
class VideoTranscript:
    """Video transcript with timestamps."""
    text: str
    segments: List[dict] = field(default_factory=list)  # time, speaker, text
    speakers: List[str] = field(default_factory=list)
    duration_seconds: int = 0


@dataclass
class VideoSummary:
    """Summary of video content."""
    url: str
    title: str
    description: str
    duration_seconds: int
    summary_text: str
    keyframes: List[Keyframe] = field(default_factory=list)
    transcript: Optional[VideoTranscript] = None
    tags: List[str] = field(default_factory=list)
    source: str = "unknown"  # youtube, vimeo, etc.
    published_date: Optional[str] = None
    creator: Optional[str] = None


class MediaSummarizer:
    """Video and media content summarization."""
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or "~/Documents/Jarvis/VideoSummaries").expanduser()
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.cache: dict[str, VideoSummary] = {}
    
    async def summarize_video_from_url(self, url: str) -> VideoSummary:
        """
        Summarize video content from URL.
        
        Args:
            url: Video URL (YouTube, Vimeo, etc.)
            
        Returns:
            VideoSummary with transcription and summary
        """
        # Check cache first
        if url in self.cache:
            return self.cache[url]
        
        # In production, this would:
        # 1. Fetch video metadata (yt-dlp or similar)
        # 2. Extract audio
        # 3. Transcribe using Whisper or similar
        # 4. Summarize transcription with Claude
        # 5. Extract keyframes
        
        # For now, return mock summary
        summary = VideoSummary(
            url=url,
            title="[Video Title Placeholder]",
            description="Video content summary would appear here",
            duration_seconds=600,
            summary_text="Comprehensive summary of the video content.",
            keyframes=[
                Keyframe(
                    timestamp_seconds=0,
                    title="Introduction",
                    description="Video begins"
                ),
                Keyframe(
                    timestamp_seconds=300,
                    title="Main Topic",
                    description="Core content discussion"
                )
            ],
            transcript=VideoTranscript(
                text="Full transcript would appear here",
                duration_seconds=600
            ),
            source="unknown"
        )
        
        # Cache and return
        self.cache[url] = summary
        await self._save_summary(summary)
        
        return summary
    
    async def summarize_screen_video(
        self,
        duration_seconds: int
    ) -> VideoSummary:
        """
        Summarize video from screen recording.
        
        Args:
            duration_seconds: Duration of recording to summarize
            
        Returns:
            VideoSummary of screen recording
        """
        # In production, this would analyze screen recording
        summary = VideoSummary(
            url="screen://recording",
            title="Screen Recording Summary",
            description="Summary of screen activity",
            duration_seconds=duration_seconds,
            summary_text="This screen recording captured...",
            source="screen_capture"
        )
        
        return summary
    
    async def extract_video_highlights(self, url: str) -> List[Keyframe]:
        """
        Extract highlight keyframes from video.
        
        Args:
            url: Video URL
            
        Returns:
            List of Keyframe objects for highlights
        """
        # Check cache
        if url in self.cache:
            return self.cache[url].keyframes
        
        # In production, would analyze video to find highlights
        # Could use scene detection, audio prominence, etc.
        
        highlights = [
            Keyframe(
                timestamp_seconds=10,
                title="Highlight 1",
                description="Important moment",
                importance=0.9
            ),
            Keyframe(
                timestamp_seconds=300,
                title="Highlight 2",
                description="Key takeaway",
                importance=0.8
            )
        ]
        
        return highlights
    
    async def get_transcript(self, url: str) -> VideoTranscript:
        """
        Get transcript for video.
        
        Args:
            url: Video URL
            
        Returns:
            VideoTranscript with full text
        """
        if url in self.cache:
            return self.cache[url].transcript or VideoTranscript(text="")
        
        # In production, would extract and transcribe audio
        transcript = VideoTranscript(
            text="Full video transcript would appear here",
            duration_seconds=600,
            segments=[
                {"time": 0, "speaker": "Speaker", "text": "Opening statement"},
                {"time": 30, "speaker": "Speaker", "text": "Main content continues"}
            ]
        )
        
        return transcript
    
    async def _save_summary(self, summary: VideoSummary) -> None:
        """Save summary to disk."""
        # Create filename from URL
        safe_filename = summary.url.replace("https://", "").replace("http://", "")[:50] + ".json"
        filepath = self.storage_path / safe_filename
        
        try:
            with open(filepath, 'w') as f:
                json.dump({
                    "url": summary.url,
                    "title": summary.title,
                    "description": summary.description,
                    "duration_seconds": summary.duration_seconds,
                    "summary_text": summary.summary_text,
                    "saved_date": datetime.now().isoformat()
                }, f, indent=2)
        except Exception:
            pass  # Silently fail on save
    
    async def search_summaries(self, query: str) -> List[VideoSummary]:
        """
        Search cached video summaries.
        
        Args:
            query: Search term
            
        Returns:
            List of matching summaries
        """
        results = []
        query_lower = query.lower()
        
        for summary in self.cache.values():
            if (query_lower in summary.title.lower() or
                query_lower in summary.description.lower() or
                any(query_lower in tag.lower() for tag in summary.tags)):
                results.append(summary)
        
        return results


# MCP Server builder
def build_server():
    """Build MCP server for MediaSummarizer."""
    
    summarizer = MediaSummarizer()
    
    class MediaSummarizerServer:
        """MCP server for video summarization."""
        
        def __init__(self):
            self.summarizer = summarizer
        
        async def summarize_video(self, url: str) -> dict:
            """Summarize a video."""
            summary = await self.summarizer.summarize_video_from_url(url)
            return {
                "url": summary.url,
                "title": summary.title,
                "description": summary.description,
                "duration_seconds": summary.duration_seconds,
                "summary": summary.summary_text,
                "keyframes_count": len(summary.keyframes),
                "has_transcript": summary.transcript is not None,
                "source": summary.source
            }
        
        async def get_highlights(self, url: str) -> dict:
            """Get video highlights."""
            highlights = await self.summarizer.extract_video_highlights(url)
            return {
                "url": url,
                "highlights": [
                    {
                        "time_seconds": h.timestamp_seconds,
                        "title": h.title,
                        "description": h.description,
                        "importance": h.importance
                    }
                    for h in highlights
                ]
            }
        
        async def get_transcript(self, url: str) -> dict:
            """Get video transcript."""
            transcript = await self.summarizer.get_transcript(url)
            return {
                "url": url,
                "text": transcript.text,
                "duration_seconds": transcript.duration_seconds,
                "segments_count": len(transcript.segments),
                "speakers": transcript.speakers
            }
        
        async def search_summaries(self, query: str) -> dict:
            """Search video summaries."""
            results = await self.summarizer.search_summaries(query)
            return {
                "query": query,
                "results_count": len(results),
                "results": [
                    {
                        "url": r.url,
                        "title": r.title,
                        "duration_seconds": r.duration_seconds
                    }
                    for r in results
                ]
            }
    
    return MediaSummarizerServer()
