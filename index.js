import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";

const server = new McpServer({ name: "variantToPhenotype", version: "1.0.0" });
const axiosClient = axios.create({ timeout: 10000 });

// API call helper with retries
async function makeApiCall(url, options = {}, maxRetries = 2) {
  const headers = options.headers || { "Content-Type": "application/json" };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return (await axiosClient.get(url, { ...options, headers })).data;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
}

// Parse variant format (HGVS, gene-based, rsID)
function parseVariantFormat(variant) {
  try {
    if (variant.match(/^[A-Za-z0-9]+\.[0-9]+:[gcp]\./))
      return { format: "hgvs", hgvs: variant };
    
    const geneMatch = variant.match(/^([A-Za-z0-9]+)[\s:]([cp]\..*)/);
    if (geneMatch) {
      const [_, gene, cdnaVariant] = geneMatch;
      return { format: "cdna", gene, variant: cdnaVariant };
    }
    
    if (variant.match(/^rs[0-9]+$/))
      return { format: "rsid", hgvs: variant };
    
    return { error: "Unrecognized variant format" };
  } catch (error) {
    return { error: "Failed to parse variant format" };
  }
}

// Main function to explore variant phenotypes
async function variantToPhenotypeExploration(variant) {
  try {
    // Initialize results object
    const results = { variant, parsed: null, hgvs: null, coordinates: null, annotations: {} };
    
    // Step 1: Parse variant format
    const parsedVariant = parseVariantFormat(variant);
    if (parsedVariant.error) {
      return { error: "Failed to parse variant format", details: parsedVariant.error };
    }
    results.parsed = parsedVariant;
    
    // Step 2: Convert to HGVS if needed
    if (parsedVariant.format === "cdna") {
      try {
        const hgvsData = await convertGeneToHGVS(parsedVariant.gene, parsedVariant.variant);
        results.hgvs = hgvsData;
      } catch (error) {
        console.error("HGVS conversion failed:", error.message);
        // Continue with gene coordinates as fallback
        results.hgvs = {
          gene: parsedVariant.gene,
          variant: parsedVariant.variant,
          format: "cdna",
          conversionError: error.message
        };
      }
    } else if (parsedVariant.format === "hgvs" || parsedVariant.format === "rsid") {
      results.hgvs = { format: parsedVariant.format, hgvs: parsedVariant.hgvs };
    }
    
    // Step 3: Get genomic coordinates
    try {
      if (results.hgvs?.hgvs) {
        try {
          const coords = await convertHGVS(results.hgvs.hgvs);
          results.coordinates = coords;
        } catch (error) {
          console.error("HGVS conversion failed:", error.message);
          // Try to get coordinates from gene if available
          if (results.hgvs.gene || parsedVariant.gene) {
            const geneCoords = await getGeneCoordinates(results.hgvs.gene || parsedVariant.gene);
            results.coordinates = {
              seq_region_name: geneCoords.seq_region_name,
              start: geneCoords.start,
              end: geneCoords.end,
              approximate: true,
              gene: geneCoords.gene
            };
          }
        }
      } else if (parsedVariant.format === "cdna") {
        // Try to get coordinates from gene
        const geneCoords = await getGeneCoordinates(parsedVariant.gene);
        results.coordinates = {
          seq_region_name: geneCoords.seq_region_name,
          start: geneCoords.start,
          end: geneCoords.end,
          approximate: true,
          gene: geneCoords.gene
        };
      }
    } catch (error) {
      return { error: "Failed to get genomic coordinates", details: error.message };
    }
    
    // Step 4: Get annotations from databases
    if (results.coordinates) {
      try {
        // Get annotations in parallel
        const [geneAnnotations, conservationScores, knownSNPs, clinvarData] = await Promise.all([
          fetchGeneAnnotations(results.coordinates).catch(() => null),
          fetchConservationScores(results.coordinates).catch(() => null),
          fetchKnownSNPs(results.coordinates).catch(() => null),
          fetchClinVarData(results.coordinates).catch(() => null)
        ]);
        
        results.annotations = {
          genes: geneAnnotations,
          conservation: conservationScores,
          snps: knownSNPs,
          clinvar: clinvarData
        };
      } catch (error) {
        // Continue with partial results
        results.annotationError = error.message;
      }
    }
    
    return results;
  } catch (error) {
    return { error: "Failed to process variant", details: error.message };
  }
}

// Get gene coordinates
async function getGeneCoordinates(geneName) {
  const url = `https://rest.ensembl.org/lookup/symbol/homo_sapiens/${geneName}?content-type=application/json`;
  const data = await makeApiCall(url);
  
  if (!data || !data.seq_region_name)
    throw new Error("No coordinate data returned for gene");
  
  return {
    seq_region_name: data.seq_region_name,
    start: data.start,
    end: data.end,
    strand: data.strand,
    gene: geneName
  };
}

// Convert HGVS to genomic coordinates
async function convertHGVS(hgvs) {
  try {
    // Handle rsID format
    if (hgvs.startsWith('rs')) {
      const url = `https://rest.ensembl.org/variation/human/${hgvs}?content-type=application/json`;
      const data = await makeApiCall(url);
      
      if (!data) throw new Error("No data returned from Ensembl for rsID");
      
      const mappings = data.mappings || [];
      const grch38Mapping = mappings.find(m => m.assembly_name === "GRCh38");
      
      if (!grch38Mapping) throw new Error("No GRCh38 mapping found for this rsID");
      
      return {
        seq_region_name: grch38Mapping.seq_region_name,
        start: grch38Mapping.start,
        end: grch38Mapping.end,
        strand: grch38Mapping.strand,
        allele_string: data.allele_string,
        source: "rsid_direct"
      };
    } 
    // Handle genomic HGVS format
    else {
      // For genomic variants, try direct lookup first
      try {
        // Check if this might be an rsID without the 'rs' prefix
        if (/^\d+$/.test(hgvs)) {
          try {
            const rsid = `rs${hgvs}`;
            const rsUrl = `https://rest.ensembl.org/variation/human/${rsid}?content-type=application/json`;
            const rsData = await makeApiCall(rsUrl);
            
            if (rsData && rsData.mappings) {
              const grch38Mapping = rsData.mappings.find(m => m.assembly_name === "GRCh38");
              if (grch38Mapping) {
                return {
                  seq_region_name: grch38Mapping.seq_region_name,
                  start: grch38Mapping.start,
                  end: grch38Mapping.end,
                  strand: grch38Mapping.strand,
                  allele_string: rsData.allele_string,
                  source: "rsid_inferred"
                };
              }
            }
          } catch (rsError) {
            // Silently continue if this approach fails
          }
        }
        
        // Try using the variant recoder API first for HGVS notation
        if (hgvs.includes(':')) {
          try {
            const recoderData = await useVariantRecoderAPI(hgvs);
            if (recoderData) {
              return recoderData;
            }
          } catch (recoderError) {
            console.error("Variant Recoder API failed:", recoderError.message);
            // Continue to other methods if recoder fails
          }
        }
        
        // Try variation API first if it doesn't look like a proper HGVS
        if (!hgvs.includes(':')) {
          try {
            const variationUrl = `https://rest.ensembl.org/variation/human/${encodeURIComponent(hgvs)}?content-type=application/json`;
            const variationData = await makeApiCall(variationUrl);
            
            if (variationData && variationData.mappings) {
              const grch38Mapping = variationData.mappings.find(m => m.assembly_name === "GRCh38");
              if (grch38Mapping) {
                return {
                  seq_region_name: grch38Mapping.seq_region_name,
                  start: grch38Mapping.start,
                  end: grch38Mapping.end,
                  strand: grch38Mapping.strand,
                  allele_string: variationData.allele_string,
                  source: "variation_api"
                };
              }
            }
          } catch (variationError) {
            console.error("Variation API failed:", variationError.message);
            // Continue to variant API if variation API fails
          }
        }
        
        // Try variant API as a fallback
        const encodedHgvs = encodeURIComponent(hgvs);
        const variantUrl = `https://rest.ensembl.org/variant/human/${encodedHgvs}?content-type=application/json`;
        
        try {
          const data = await makeApiCall(variantUrl);
          
          if (!data) throw new Error("No data returned from Ensembl for variant");
          
          if (!data.seq_region_name) throw new Error("Invalid response from variant API");
          
          return {
            seq_region_name: data.seq_region_name,
            start: data.start,
            end: data.end,
            strand: data.strand,
            allele_string: data.allele_string,
            source: "variant_direct"
          };
        } catch (variantError) {
          // If all direct lookups fail, try alternative approaches
          console.error("All direct variant lookups failed");
          
          // Try to extract gene name if it's in the HGVS
          if (hgvs.includes(':')) {
            const genePart = hgvs.split(':')[0];
            const possibleGene = genePart.match(/[A-Za-z0-9]+/)?.[0];
            
            if (possibleGene) {
              try {
                const geneCoords = await getGeneCoordinates(possibleGene);
                return {
                  ...geneCoords,
                  approximate: true,
                  source: "gene_fallback",
                  originalError: "All direct variant lookups failed"
                };
              } catch (geneError) {
                throw new Error(`All direct variant lookups failed. Gene fallback also failed: ${geneError.message}`);
              }
            }
          }
          
          throw new Error("Could not convert variant to genomic coordinates");
        }
      } catch (error) {
        throw error;
      }
    }
  } catch (error) {
    throw error;
  }
}

// Use the Variant Recoder API to convert HGVS notation to genomic coordinates
async function useVariantRecoderAPI(hgvs) {
  try {
    const url = `https://rest.ensembl.org/variant_recoder/human/${encodeURIComponent(hgvs)}?content-type=application/json`;
    const data = await makeApiCall(url);
    
    if (!data || data.length === 0) {
      throw new Error("No data returned from Variant Recoder API");
    }
    
    // The response is an array with objects containing allele-specific data
    // We need to extract the genomic HGVS (hgvsg) and parse it
    const firstVariant = data[0];
    const alleles = Object.values(firstVariant);
    
    // Find the first allele with hgvsg data
    for (const allele of alleles) {
      if (allele.hgvsg && allele.hgvsg.length > 0) {
        // Parse the first hgvsg notation (e.g., "NC_000017.11:g.43094464dupC")
        const hgvsg = allele.hgvsg[0];
        
        // Extract chromosome, position, and variant
        const match = hgvsg.match(/NC_0+(\d+)\.\d+:g\.(\d+)([a-zA-Z>]+.+)/);
        if (match) {
          const [, chrNum, pos, change] = match;
          
          return {
            seq_region_name: chrNum,
            start: parseInt(pos),
            end: parseInt(pos),
            allele_string: change,
            source: "variant_recoder"
          };
        }
      }
    }
    
    throw new Error("Could not extract genomic coordinates from Variant Recoder API response");
  } catch (error) {
    throw error;
  }
}

// Fetch data from UCSC API
async function fetchUcscData(coords, track) {
  const { seq_region_name, start, end } = coords;
  const chrom = seq_region_name.startsWith('chr') ? seq_region_name : `chr${seq_region_name}`;
  
  // Limit the region size to avoid 400/500 errors (UCSC has limits on region size)
  const maxRegionSize = 1000000;
  const regionSize = end - start + 1;
  const adjustedStart = regionSize > maxRegionSize ? end - maxRegionSize : start;
  const adjustedEnd = adjustedStart + Math.min(regionSize, maxRegionSize);
  
  const url = `https://api.genome.ucsc.edu/getData/track?genome=hg38;track=${track};chrom=${chrom};start=${adjustedStart};end=${adjustedEnd}`;
  
  try {
    const data = await makeApiCall(url);
    if (!data) return null;
    if (data.error) {
      console.error(`UCSC API error for ${track}: ${data.error}`);
      return null;
    }
    return data;
  } catch (error) {
    console.error(`Failed to fetch ${track} data: ${error.message}`);
    return null;
  }
}

// Fetch gene annotations
async function fetchGeneAnnotations(coords) {
  return fetchUcscData(coords, 'knownGene');
}

// Fetch conservation scores
async function fetchConservationScores(coords) {
  // Use phastCons20way instead of phastCons100way (more reliable)
  return fetchUcscData(coords, 'phastCons20way');
}

// Fetch known SNPs
async function fetchKnownSNPs(coords) {
  // Use snp150 instead of snp151 (more stable)
  return fetchUcscData(coords, 'snp150');
}

// Fetch ClinVar data
async function fetchClinVarData(coords) {
  // Use specific version of ClinVar for better stability
  return fetchUcscData(coords, 'clinvar_20221231');
}

// Convert gene to HGVS
async function convertGeneToHGVS(gene, cdnaVariant) {
  // Try multiple approaches in sequence
  const errors = [];

  // Approach 1: Try direct rsID lookup if the variant format suggests it might be a known variant
  try {
    // For common mutation patterns like deletions, insertions, etc.
    if (cdnaVariant.match(/del|ins|dup|>|fs/)) {
      // Try to find the variant in ClinVar or other databases
      console.log(`Trying to find ${gene} ${cdnaVariant} in variation database...`);
      
      // Search for the variant using gene name and cdna notation
      const searchUrl = `https://rest.ensembl.org/variation/human?symbol=${gene};content-type=application/json`;
      const searchData = await makeApiCall(searchUrl).catch(() => null);
      
      if (searchData) {
        // Look for matching variants
        const matchingVariant = searchData.find(v => 
          v.phenotypes && 
          v.synonyms && 
          v.synonyms.some(s => s.includes(cdnaVariant))
        );
        
        if (matchingVariant) {
          console.log(`Found matching variant: ${matchingVariant.id}`);
          return {
            gene,
            variant: cdnaVariant,
            hgvs: matchingVariant.id,
            format: "rsid"
          };
        }
      }
    }
  } catch (error) {
    errors.push(`Direct lookup approach failed: ${error.message}`);
  }
  
  // Get transcript ID
  try {
    const geneData = await makeApiCall(
      `https://rest.ensembl.org/lookup/symbol/homo_sapiens/${gene}?expand=1;content-type=application/json`
    );
    
    if (!geneData || !geneData.id) throw new Error("Gene not found in Ensembl");
    
    const transcripts = geneData.Transcript;
    if (!transcripts || transcripts.length === 0) throw new Error("No transcripts found for gene");
    
    // Try to find canonical transcript first
    const canonicalTranscript = transcripts.find(t => t.is_canonical) || transcripts[0];
    const transcriptId = canonicalTranscript.id;
    
    // Try multiple transcript IDs if the first one fails
    const transcriptsToTry = [
      transcriptId,
      ...transcripts.slice(0, 3).map(t => t.id).filter(id => id !== transcriptId)
    ];
    
    // Try each transcript until one works
    let lastError = null;
    for (const currentTranscriptId of transcriptsToTry) {
      try {
        // Convert to HGVS using variant recoder
        const recoderUrl = `https://rest.ensembl.org/variant_recoder/human/${currentTranscriptId}:${cdnaVariant}?content-type=application/json`;
        console.log(`Trying Variant Recoder with transcript ${currentTranscriptId}...`);
        
        const recoderData = await makeApiCall(recoderUrl);
        
        if (!recoderData || recoderData.length === 0) {
          lastError = new Error(`No data returned from Variant Recoder for transcript ${currentTranscriptId}`);
          continue; // Try next transcript
        }
        
        // The response format is an array of objects where each object has allele-specific properties
        const firstVariant = recoderData[0];
        
        // Check if we have any data in the response
        if (!firstVariant || Object.keys(firstVariant).length === 0) {
          lastError = new Error(`Empty variant data for transcript ${currentTranscriptId}`);
          continue; // Try next transcript
        }
        
        // Extract data from the first allele
        const alleles = Object.values(firstVariant);
        if (!alleles || alleles.length === 0) {
          lastError = new Error(`No allele data found for transcript ${currentTranscriptId}`);
          continue; // Try next transcript
        }
        
        const firstAllele = alleles[0];
        
        // Check for any available notation in priority order: genomic, transcript, protein
        if (firstAllele.hgvsg && firstAllele.hgvsg.length > 0) {
          return { 
            gene, 
            variant: cdnaVariant, 
            hgvs: firstAllele.hgvsg[0], 
            format: "hgvsg",
            transcript: currentTranscriptId
          };
        } else if (firstAllele.hgvsc && firstAllele.hgvsc.length > 0) {
          return { 
            gene, 
            variant: cdnaVariant, 
            hgvs: firstAllele.hgvsc[0], 
            format: "hgvsc",
            transcript: currentTranscriptId
          };
        } else if (firstAllele.hgvsp && firstAllele.hgvsp.length > 0) {
          return { 
            gene, 
            variant: cdnaVariant, 
            hgvs: firstAllele.hgvsp[0], 
            format: "hgvsp",
            transcript: currentTranscriptId
          };
        } else if (firstAllele.spdi && firstAllele.spdi.length > 0) {
          return {
            gene,
            variant: cdnaVariant,
            hgvs: firstAllele.spdi[0],
            format: "spdi",
            transcript: currentTranscriptId
          };
        } else if (firstAllele.id && firstAllele.id.length > 0) {
          // If we have an rsID, we can use that
          const rsid = firstAllele.id[0];
          return {
            gene,
            variant: cdnaVariant,
            hgvs: rsid,
            format: "rsid",
            transcript: currentTranscriptId
          };
        }
        
        // If we got here, we have data but no usable notation
        lastError = new Error(`No usable notation found in response for transcript ${currentTranscriptId}`);
      } catch (error) {
        lastError = error;
        // Continue to next transcript
      }
    }
    
    // If we've tried all transcripts and none worked, try a fallback approach
    try {
      // Fallback to gene coordinates
      console.log("All transcripts failed, falling back to gene coordinates...");
      const geneCoords = await getGeneCoordinates(gene);
      
      return {
        gene,
        variant: cdnaVariant,
        coordinates: geneCoords,
        format: "gene_coordinates",
        approximate: true
      };
    } catch (fallbackError) {
      throw lastError || new Error("Failed to convert to HGVS notation with any transcript");
    }
  } catch (error) {
    throw error;
  }
}

// Register the tool
server.tool(
  "variantToPhenotypeExploration",
  { variant: z.string() },
  async ({ variant }) => ({
    content: [{
      type: "text",
      text: JSON.stringify(await variantToPhenotypeExploration(variant))
    }]
  })
);

// Start the server
async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
