import { describe, expect, it } from 'vitest';
import { ClientMessageSchema, GetRenderStateResultSchema, ProposeOperationParamsSchema, ProtocolVersionSchema, ToolNameSchema, ToolParamsSchemaByName, V3GetRenderStateResultSchema, V3OperationTargetSchema } from '../index';

describe('agent protocol v3 additive surface', () => {
  it('accepts protocol versions 2 and 3', () => {
    expect(ProtocolVersionSchema.parse(2)).toBe(2);
    expect(ProtocolVersionSchema.parse(3)).toBe(3);
  });

  it('parses generic propose_operation params with discriminated targets', () => {
    expect(ToolNameSchema.parse('propose_operation')).toBe('propose_operation');
    const parsed = ProposeOperationParamsSchema.parse({
      requestId: 'req_cut_001',
      type: 'cut',
      target: { kind: 'clip-span', trackId: 'track_video', clipId: 'clip_1', start: 1, end: 2 },
      reason: 'tighten'
    });
    expect(parsed.target.kind).toBe('clip-span');
    expect(() => V3OperationTargetSchema.parse({ kind: 'clip-span', trackId: 't', clipId: 'c', start: 2, end: 1 })).toThrow();
  });

  it('keeps v2 tool calls valid and allows v3 tool calls', () => {
    expect(ClientMessageSchema.parse({ kind: 'tool_call', id: 'call1', protocolVersion: 2, tool: 'propose_cut', params: {} }).protocolVersion).toBe(2);
    const parsed = ClientMessageSchema.parse({ kind: 'tool_call', id: 'call2', protocolVersion: 3, tool: 'add_track', params: { requestId: 'req_add_track_001', trackId: 'track_music', kind: 'audio', subtype: 'music', name: 'Music', order: 2 } });
    expect(parsed).toMatchObject({ kind: 'tool_call', tool: 'add_track' });
  });

  it('parses v3 get_render_state result without changing the v2 result schema', () => {
    const v3 = V3GetRenderStateResultSchema.parse({ manifestValid: true, manifestErrors: [], renderPlan: { timeMap: { segments: [] }, stages: [] } });
    expect(v3.renderPlan).toMatchObject({ stages: [] });
    expect(() => GetRenderStateResultSchema.parse({ manifestValid: true, manifestErrors: [], renderPlan: null })).toThrow();
  });

  it('tightens common v3 structural params', () => {
    expect(ToolParamsSchemaByName.detach_audio.parse({ requestId: 'req_detach_audio_001', clipId: 'clip_1', detachedClipId: 'clip_audio' })).toMatchObject({ clipId: 'clip_1' });
    expect(() => ToolParamsSchemaByName.detach_audio.parse({ requestId: 'req_detach_audio_002', clipId: 'clip_1', extractedAssetId: 'asset_override' })).toThrow();
    expect(() => ToolParamsSchemaByName.remove_track.parse({})).toThrow();
  });
});
