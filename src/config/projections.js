import * as d3 from 'd3';
import * as d3Proj from 'd3-geo-projection';

export const PROJECTIONS = [
  {
    id: 'mercator',
    name: 'Mercator',
    project: (scale = 120) => d3.geoMercator().scale(scale).translate([0, 0]),
    defaultScale: 120,
    clampLat: 85.0511
  },
  {
    id: 'natural-earth-2',
    name: 'Natural Earth 2',
    project: (scale = 120) => d3Proj.geoNaturalEarth2().scale(scale).translate([0, 0]),
    defaultScale: 120,
    clampLat: 89.9
  },
  {
    id: 'mollweide',
    name: 'Mollweide',
    project: (scale = 120) => d3Proj.geoMollweide().scale(scale).translate([0, 0]),
    defaultScale: 120,
    clampLat: 89.9
  },
  {
    id: 'robinson',
    name: 'Robinson',
    project: (scale = 120) => d3Proj.geoRobinson().scale(scale).translate([0, 0]),
    defaultScale: 120,
    clampLat: 89.9
  },
  {
    id: 'winkel3',
    name: 'Winkel Tripel',
    project: (scale = 120) => d3Proj.geoWinkel3().scale(scale).translate([0, 0]),
    defaultScale: 120,
    clampLat: 89.9
  }
];

export function getProjectionById(id) {
  return PROJECTIONS.find(p => p.id === id) || PROJECTIONS[0];
}
