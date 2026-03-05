use spacetimedb::{table, reducer, ReducerContext, Identity, Table, Timestamp};

#[table(accessor = dj_set, public)]
pub struct DjSet {
    #[primary_key]
    pub id: u32,
    pub current_code: String,
    pub current_vibe: String,
    pub current_persona: String,
    pub cpm: u32,
    pub playback_active: bool,
    pub last_updated_at: Timestamp,
}

#[table(accessor = music_request, public)]
pub struct MusicRequest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub sender: Identity,
    pub text: String,
    pub priority: String,
    pub status: String, // "pending", "processing", "completed", "failed"
    pub created_at: Timestamp,
}

#[table(accessor = dj_persona, public)]
pub struct DjPersona {
    #[primary_key]
    pub name: String,
    pub prompt_override: String,
    pub description: String,
}

#[reducer]
pub fn init_set(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.dj_set().id().find(1).is_some() {
        return Ok(());
    }

    ctx.db.dj_set().insert(DjSet {
        id: 1,
        current_code: "setcpm(124)\n$: s(\"bd*4\")".to_string(),
        current_vibe: "minimal techno".to_string(),
        current_persona: "The Architect".to_string(),
        cpm: 124,
        playback_active: false,
        last_updated_at: ctx.timestamp,
    });

    ctx.db.dj_persona().insert(DjPersona {
        name: "The Architect".to_string(),
        prompt_override: "Focus on clean, mathematical techno patterns with complex percussion.".to_string(),
        description: "Precise and minimal.".to_string(),
    });

    ctx.db.dj_persona().insert(DjPersona {
        name: "Liquid Weaver".to_string(),
        prompt_override: "Generate ethereal, ambient soundscapes with long decays and soft transients.".to_string(),
        description: "Fluid and atmospheric.".to_string(),
    });

    Ok(())
}

#[reducer]
pub fn update_pattern(ctx: &ReducerContext, code: String, vibe: String) -> Result<(), String> {
    let mut set = ctx.db.dj_set().id().find(1).ok_or("Set not initialized")?;
    set.current_code = code;
    set.current_vibe = vibe;
    set.last_updated_at = ctx.timestamp;
    ctx.db.dj_set().id().update(set);
    Ok(())
}

#[reducer]
pub fn set_persona(ctx: &ReducerContext, persona_name: String) -> Result<(), String> {
    let mut set = ctx.db.dj_set().id().find(1).ok_or("Set not initialized")?;
    if ctx.db.dj_persona().name().find(persona_name.clone()).is_none() {
        return Err("Persona not found".to_string());
    }
    set.current_persona = persona_name;
    set.last_updated_at = ctx.timestamp;
    ctx.db.dj_set().id().update(set);
    Ok(())
}

#[reducer]
pub fn submit_request(ctx: &ReducerContext, text: String, priority: String) -> Result<(), String> {
    ctx.db.music_request().insert(MusicRequest {
        id: 0,
        sender: ctx.sender(),
        text,
        priority,
        status: "pending".to_string(),
        created_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn set_playback(ctx: &ReducerContext, active: bool) -> Result<(), String> {
    let mut set = ctx.db.dj_set().id().find(1).ok_or("Set not initialized")?;
    set.playback_active = active;
    set.last_updated_at = ctx.timestamp;
    ctx.db.dj_set().id().update(set);
    Ok(())
}
