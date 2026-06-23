import type { CoreWorld, Vec3 } from '@kikorin/ecs'
import { hasComponent } from 'bitecs'
import { fillWorldHalfExtents } from './colliderUtils'

const COLLISION_RESPONSE_PREDICTION = 0.001
const COLLISION_BOUNCE_RESTITUTION = 0.8
const COLLISION_MIN_BOUNCE_SPEED = 0.75

type Vec3Like = { x: number; y: number; z: number }

function dot(a: Vec3Like, b: Vec3Like) {
    return a.x * b.x + a.y * b.y + a.z * b.z
}

function lengthSquared(v: Vec3Like) {
    return dot(v, v)
}

function normalize(v: Vec3Like): Vec3Like | null {
    const lenSq = lengthSquared(v)
    if (lenSq === 0) return null
    const inv = 1 / Math.sqrt(lenSq)
    return { x: v.x * inv, y: v.y * inv, z: v.z * inv }
}

export function pairKeyFor(world: CoreWorld, a: number, b: number): number {
    const min = a < b ? a : b
    const max = a < b ? b : a
    const entityStride = world.components.Render.length
    return min * entityStride + max
}

export function resetBounceSuggestions(world: CoreWorld) {
    const suggestions = world.collision.bounceSuggestions
    const dirtyCount = suggestions.DirtyCount
    for (let i = 0; i < dirtyCount; i += 1) {
        const eid = suggestions.DirtyList[i]!
        suggestions.Active[eid] = 0
        suggestions.x[eid] = 0
        suggestions.y[eid] = 0
        suggestions.z[eid] = 0
        suggestions.DirtyFlagSet[eid] = 0
    }
    suggestions.DirtyCount = 0
}

export function addBounceSuggestion(world: CoreWorld, eid: number, delta: Vec3Like) {
    if (delta.x === 0 && delta.y === 0 && delta.z === 0) return

    const suggestions = world.collision.bounceSuggestions
    if (!suggestions.DirtyFlagSet[eid]) {
        const dirtyIndex = suggestions.DirtyCount
        suggestions.DirtyFlagSet[eid] = 1
        suggestions.DirtyList[dirtyIndex] = eid
        suggestions.DirtyCount = dirtyIndex + 1
    }

    suggestions.Active[eid] = 1
    suggestions.x[eid] += delta.x
    suggestions.y[eid] += delta.y
    suggestions.z[eid] += delta.z
}

function computeCollisionBounceResponses(
    world: CoreWorld,
    a: number,
    b: number,
    normal: Vec3Like,
) {
    const { Collider, Floor, Position, Velocity } = world.components
    if (Collider.Sensor[a] || Collider.Sensor[b] || Floor[a] || Floor[b]) return null

    let normalizedNormal = normalize(normal)
    if (!normalizedNormal) {
        normalizedNormal = normalize({
            x: Position.x[b] - Position.x[a],
            y: Position.y[b] - Position.y[a],
            z: Position.z[b] - Position.z[a],
        })
    }
    if (!normalizedNormal) return null

    const aDynamic = hasComponent(world, a, Velocity)
    const bDynamic = hasComponent(world, b, Velocity)
    const dynamicCount = Number(aDynamic) + Number(bDynamic)
    if (dynamicCount === 0) return null

    const relativeVelocity = {
        x: (aDynamic ? Velocity.x[a] : 0) - (bDynamic ? Velocity.x[b] : 0),
        y: (aDynamic ? Velocity.y[a] : 0) - (bDynamic ? Velocity.y[b] : 0),
        z: (aDynamic ? Velocity.z[a] : 0) - (bDynamic ? Velocity.z[b] : 0),
    }
    const closingSpeed = dot(relativeVelocity, normalizedNormal)
    if (closingSpeed <= COLLISION_MIN_BOUNCE_SPEED) return null

    const bounceImpulse = ((1 + COLLISION_BOUNCE_RESTITUTION) * closingSpeed) / dynamicCount
    const response = {
        a: aDynamic ? {
            x: -normalizedNormal.x * bounceImpulse,
            y: -normalizedNormal.y * bounceImpulse,
            z: -normalizedNormal.z * bounceImpulse,
        } : null,
        b: bDynamic ? {
            x: normalizedNormal.x * bounceImpulse,
            y: normalizedNormal.y * bounceImpulse,
            z: normalizedNormal.z * bounceImpulse,
        } : null,
    }

    return response.a || response.b ? response : null
}

function suggestCollisionBounce(world: CoreWorld, a: number, b: number): boolean {
    const state = world.collision
    const aCollider = state.collidersByEid[a]
    const bCollider = state.collidersByEid[b]
    if (!aCollider?.isValid() || !bCollider?.isValid()) return false

    const contact = aCollider.contactCollider(bCollider, COLLISION_RESPONSE_PREDICTION)
    if (!contact) return false

    const response = computeCollisionBounceResponses(world, a, b, contact.normal1)
    if (!response) return false

    if (response.a) addBounceSuggestion(world, a, response.a)
    if (response.b) addBounceSuggestion(world, b, response.b)
    return true
}

export function computeBounceSuggestions(world: CoreWorld, seedEids: readonly number[]) {
    const state = world.collision
    if (!state.world) return

    const aabbHalfExtents: Vec3Like = { x: 0, y: 0, z: 0 }
    const processedKeys = new Set<number>()

    for (let i = 0; i < seedEids.length; i += 1) {
        const eid = seedEids[i]!
        const collider = state.collidersByEid[eid]
        if (!collider?.isValid()) continue

        fillWorldHalfExtents(world, eid, aabbHalfExtents)

        state.world.collidersWithAabbIntersectingAabb(
            collider.translation(),
            {
                x: aabbHalfExtents.x + COLLISION_RESPONSE_PREDICTION,
                y: aabbHalfExtents.y + COLLISION_RESPONSE_PREDICTION,
                z: aabbHalfExtents.z + COLLISION_RESPONSE_PREDICTION,
            },
            (candidate) => {
                const otherEid = state.eidByColliderHandle.get(candidate.handle)
                if (otherEid === undefined || otherEid === eid) return true

                const key = pairKeyFor(world, eid, otherEid)
                if (processedKeys.has(key)) return true

                processedKeys.add(key)
                suggestCollisionBounce(world, eid, otherEid)
                return true
            },
        )
    }
}

export function getBounceSuggestion(world: CoreWorld, eid: number): Vec3 | null {
    const suggestions = world.collision.bounceSuggestions
    if (!suggestions.Active[eid]) return null
    return {
        x: suggestions.x[eid],
        y: suggestions.y[eid],
        z: suggestions.z[eid],
    }
}

export function getCollisionBounceDelta(
    world: CoreWorld,
    eid: number,
    otherEid: number,
    normal: Vec3,
): Vec3 | null {
    const response = computeCollisionBounceResponses(world, eid, otherEid, normal)
    return response?.a ?? null
}

// Uses the actual contact normal from Rapier rather than a caller-supplied normal.
export function getContactBounceDelta(
    world: CoreWorld,
    eid: number,
    otherEid: number,
): Vec3 | null {
    const state = world.collision
    const aCollider = state.collidersByEid[eid]
    const bCollider = state.collidersByEid[otherEid]
    if (!aCollider?.isValid() || !bCollider?.isValid()) return null

    const contact = aCollider.contactCollider(bCollider, COLLISION_RESPONSE_PREDICTION)
    if (!contact) return null

    const response = computeCollisionBounceResponses(world, eid, otherEid, contact.normal1)
    return response?.a ?? null
}
