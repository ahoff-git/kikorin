import type { ComponentId, ComponentSchema, DeltaSet, EntityId } from './types'

// Per-entity, per-component field snapshot.
// Indexed as Float64Array with stride = fieldCount, so slot[fieldId] = last sent value.
type ComponentSnapshot = Float64Array

// Snapshot store: componentId → Float64Array[eid * fieldCount + fieldId]
type EntitySnapshot = Map<ComponentId, ComponentSnapshot>

/**
 * Tracks the last-flushed values of registered ECS components and produces
 * minimal delta sets by comparing current TypedArray state to the snapshot.
 *
 * Thread of ownership: single-threaded (JS). Call markDirty() whenever an
 * ECS system modifies a component, then flush() once per network tick to
 * collect only what changed.
 */
export class ChangeTracker {
  private _schemas = new Map<ComponentId, ComponentSchema>()
  // Flat snapshot per entity (reused across components)
  private _snapshots = new Map<EntityId, EntitySnapshot>()
  private _dirtySet = new Set<EntityId>()

  registerComponent(schema: ComponentSchema): void {
    if (this._schemas.has(schema.id)) {
      throw new Error(`Component id ${schema.id} already registered`)
    }
    this._schemas.set(schema.id, schema)
  }

  unregisterComponent(componentId: ComponentId): void {
    this._schemas.delete(componentId)
    // Invalidate snapshots that referenced this component
    for (const snap of this._snapshots.values()) {
      snap.delete(componentId)
    }
  }

  markDirty(entityId: EntityId): void {
    this._dirtySet.add(entityId)
  }

  markDirtyBatch(entities: EntityId[]): void {
    for (const eid of entities) this._dirtySet.add(eid)
  }

  get dirtyCount(): number { return this._dirtySet.size }

  /**
   * Compute deltas for a subset of entities and update the snapshot.
   * Only entities that were marked dirty are compared; clean entities are skipped.
   * Clears dirty flags for all entities in the provided list.
   */
  flush(entities: EntityId[]): DeltaSet {
    const deltas: DeltaSet = []

    for (const eid of entities) {
      if (!this._dirtySet.has(eid)) continue

      let entitySnap = this._snapshots.get(eid)
      if (!entitySnap) { entitySnap = new Map(); this._snapshots.set(eid, entitySnap) }

      for (const [cid, schema] of this._schemas) {
        const fieldCount = schema.fields.length
        let compSnap = entitySnap.get(cid)
        if (!compSnap) {
          compSnap = new Float64Array(fieldCount).fill(NaN)
          entitySnap.set(cid, compSnap)
        }

        for (let fi = 0; fi < fieldCount; fi++) {
          const field = schema.fields[fi]
          const cur = field.array[eid]
          if (compSnap[fi] !== cur) {
            compSnap[fi] = cur
            deltas.push({ entityId: eid, componentId: cid, fieldId: fi, value: cur })
          }
        }
      }

      this._dirtySet.delete(eid)
    }

    return deltas
  }

  /**
   * Force-flush all registered fields for the given entities, ignoring dirty state.
   * Use when a new peer joins and needs a full state sync.
   */
  fullSnapshot(entities: EntityId[]): DeltaSet {
    const deltas: DeltaSet = []

    for (const eid of entities) {
      for (const [cid, schema] of this._schemas) {
        for (let fi = 0; fi < schema.fields.length; fi++) {
          deltas.push({
            entityId: eid,
            componentId: cid,
            fieldId: fi,
            value: schema.fields[fi].array[eid],
          })
        }
      }
    }

    return deltas
  }

  /**
   * Invalidate the snapshot for an entity (e.g. after it is destroyed and respawned).
   * Next flush will treat all fields as changed.
   */
  invalidateEntity(entityId: EntityId): void {
    this._snapshots.delete(entityId)
    this._dirtySet.add(entityId)
  }

  clearDirtyAll(): void {
    this._dirtySet.clear()
  }
}
